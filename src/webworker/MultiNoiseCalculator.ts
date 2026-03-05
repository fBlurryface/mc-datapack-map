///  declare const self: ServiceWorkerGlobalScope;
export { };

import {
	Climate,
	DensityFunction,
	WorldgenRegistries,
	Identifier,
	Holder,
	NoiseGeneratorSettings,
	RandomState,
	NoiseParameters,
	BiomeSource,
} from "deepslate";

type UpdateMessage = {
	biomeSourceJson?: unknown,
	noiseGeneratorSettingsJson?: unknown,
	densityFunctions?: { [key: string]: unknown },
	noises?: { [key: string]: unknown },
	surfaceDensityFunctionId?: string,
	terrainDensityFunctionId?: string,
	generationVersion?: number,
	seed?: bigint,
	y?: number,
	project_down?: boolean,

	// NEW: when true, surface is derived by scanning NoiseRouter.finalDensity
	use_final_density_surface?: boolean,
}

class MultiNoiseCalculator {
	private state: {
		sampler?: Climate.Sampler,
		biomeSource?: BiomeSource,
		surfaceDensityFunction?: DensityFunction,
		terrainDensityFunction?: DensityFunction,

		// NEW:
		finalDensityFunction?: DensityFunction,
		useFinalDensitySurface: boolean,

		noiseGeneratorSettings?: NoiseGeneratorSettings,
		randomState?: RandomState,
		y: number,
		seed: bigint,
		projectDown: boolean,
		generationVersion: number,
	} = {
		y: 0,
		seed: BigInt(0),
		generationVersion: -1,
		projectDown: true,

		// NEW:
		useFinalDensitySurface: false,
	}

	private taskQueue: any[] = []

	public update(update: UpdateMessage) {
		this.state.seed = update.seed ?? this.state.seed
		this.state.y = update.y ?? this.state.y
		this.state.projectDown = update.project_down ?? this.state.projectDown
		this.state.generationVersion = update.generationVersion ?? this.state.generationVersion

		// NEW:
		if (update.use_final_density_surface !== undefined) {
			this.state.useFinalDensitySurface = update.use_final_density_surface
		}

		if (update.biomeSourceJson) {
			this.state.biomeSource = BiomeSource.fromJson(update.biomeSourceJson)
		}

		if (update.densityFunctions) {
			WorldgenRegistries.DENSITY_FUNCTION.clear()
			for (const id in update.densityFunctions) {
				const df = new DensityFunction.HolderHolder(
					Holder.parser(WorldgenRegistries.DENSITY_FUNCTION, DensityFunction.fromJson)(update.densityFunctions[id])
				)
				WorldgenRegistries.DENSITY_FUNCTION.register(Identifier.parse(id), df)
			}
		}

		if (update.noises) {
			WorldgenRegistries.NOISE.clear()
			for (const id in update.noises) {
				const noise = NoiseParameters.fromJson(update.noises[id])
				WorldgenRegistries.NOISE.register(Identifier.parse(id), noise)
			}
		}

		if (update.noiseGeneratorSettingsJson) {
			this.state.noiseGeneratorSettings = NoiseGeneratorSettings.fromJson(update.noiseGeneratorSettingsJson)
			this.state.randomState = new RandomState(this.state.noiseGeneratorSettings, this.state.seed)
			this.state.sampler = Climate.Sampler.fromRouter(this.state.randomState.router)
		}

		// Build mapped density functions (same as before), plus optional finalDensity.
		if (this.state.randomState && this.state.noiseGeneratorSettings) {
			const visitor = this.state.randomState.createVisitor(
				this.state.noiseGeneratorSettings.noise,
				this.state.noiseGeneratorSettings.legacyRandomSource
			)

			// surface DF (unchanged behavior)
			if (update.surfaceDensityFunctionId === "") {
				this.state.surfaceDensityFunction = undefined
			} else if (update.surfaceDensityFunctionId) {
				this.state.surfaceDensityFunction = new DensityFunction.HolderHolder(
					Holder.reference(WorldgenRegistries.DENSITY_FUNCTION, Identifier.parse(update.surfaceDensityFunctionId))
				).mapAll(visitor)
			}

			// terrain DF (unchanged behavior)
			if (update.terrainDensityFunctionId === "") {
				this.state.terrainDensityFunction = undefined
			} else if (update.terrainDensityFunctionId) {
				this.state.terrainDensityFunction = new DensityFunction.HolderHolder(
					Holder.reference(WorldgenRegistries.DENSITY_FUNCTION, Identifier.parse(update.terrainDensityFunctionId))
				).mapAll(visitor)
			}

			// NEW: cache finalDensity DF if enabled
			if (this.state.useFinalDensitySurface) {
				const router: any = this.state.randomState.router as any
				let fd: any = undefined

				// deepslate uses camelCase like finalDensity
				if (router?.finalDensity !== undefined) fd = router.finalDensity
				// some libs might expose as method
				else if (typeof router?.finalDensity === "function") fd = router.finalDensity()
				// safety: snake case fallback
				else if (router?.final_density !== undefined) fd = router.final_density

				this.state.finalDensityFunction = fd?.mapAll ? fd.mapAll(visitor) : fd
			} else {
				this.state.finalDensityFunction = undefined
			}
		}

		// clear pending tasks on any update (unchanged)
		this.taskQueue = []
	}

	public addTask(task: any) {
		this.taskQueue.push(task)
	}

	public removeTask(key: string) {
		const index = this.taskQueue.findIndex((task) => task.key === key)
		if (index >= 0) {
			this.taskQueue.splice(index, 1)
		}
	}

	public async loop() {
		while (true) {
			if (this.taskQueue.length === 0) {
				await new Promise(r => setTimeout(r, 1000))
			} else {
				const nextTask = this.taskQueue.shift()
				this.calculateMultiNoiseValues(
					nextTask.key,
					nextTask.min.x, nextTask.min.y,
					nextTask.max.x, nextTask.max.y,
					nextTask.tileSize
				)
				await new Promise(r => setTimeout(r, 0))
			}
		}
	}

	// NEW: derive surface Y by scanning finalDensity from top -> bottom.
	// Returns highest y where density > 0, or +Infinity if unknown.
	private surfaceFromFinalDensity(blockX: number, blockZ: number): number {
		const fd = this.state.finalDensityFunction
		const ngs: any = this.state.noiseGeneratorSettings as any
		if (!fd || !ngs?.noise) return Number.POSITIVE_INFINITY

		const minY: number = ngs.noise.minY ?? 0
		const height: number = ngs.noise.height ?? 256
		const maxYExclusive = minY + height

		// Start at min(state.y, top-1)
		let startY = Math.floor(Math.min(this.state.y, maxYExclusive - 1))

		// Coarse step: 8 blocks (faster), then refine within the band
		const coarseStep = 8

		let foundSolidY: number | null = null
		let lastAirY: number = startY + coarseStep // sentinel

		for (let y = startY; y >= minY; y -= coarseStep) {
			const d = fd.compute(DensityFunction.context(blockX, y, blockZ))
			if (d > 0) {
				foundSolidY = y
				break
			}
			lastAirY = y
		}

		if (foundSolidY === null) return Number.POSITIVE_INFINITY

		// refine between (foundSolidY .. lastAirY-1), inclusive
		const refineTop = Math.min(startY, lastAirY - 1)
		for (let y = refineTop; y >= foundSolidY; y--) {
			const d = fd.compute(DensityFunction.context(blockX, y, blockZ))
			if (d > 0) return y
		}

		return foundSolidY
	}

	private calculateMultiNoiseValues(
		key: string,
		min_x: number, min_z: number,
		max_x: number, max_z: number,
		tileSize: number
	): void {
		const array: { surface: number, biome: string, terrain: number }[][] = Array(tileSize + 2)
		const step = (max_x - min_x) / tileSize

		for (let ix = -1; ix < tileSize + 2; ix++) {
			array[ix] = Array(tileSize + 2)
			for (let iz = -1; iz < tileSize + 2; iz++) {
				const x = ix * step + min_x
				const z = iz * step + min_z

				// x/z in quart → block
				const bx = x * 4
				const bz = z * 4

				// surface:
				let surface: number
				if (this.state.useFinalDensitySurface) {
					surface = this.surfaceFromFinalDensity(bx, bz)
					// fallback to old method if finalDensity not available
					if (!Number.isFinite(surface)) surface = Number.POSITIVE_INFINITY
				} else {
					surface = this.state.surfaceDensityFunction?.compute(DensityFunction.context(bx, this.state.y, bz)) ?? Number.POSITIVE_INFINITY
				}

				const y = this.state.projectDown ? Math.min(surface, this.state.y) : this.state.y

				// biome sampling (unchanged)
				const biome = this.state.biomeSource?.getBiome(x, y >> 2, z, this.state.sampler!).toString() ?? "minecraft:plains"

				// terrain DF (unchanged)
				const terrain = this.state.terrainDensityFunction?.compute(DensityFunction.context(bx, y, bz)) ?? Number.POSITIVE_INFINITY

				array[ix][iz] = { surface, biome, terrain }
			}
		}

		postMessage({ key, array, step, generationVersion: this.state.generationVersion })
	}
}

const multiNoiseCalculator = new MultiNoiseCalculator()
multiNoiseCalculator.loop()

self.onmessage = (evt: MessageEvent<any>) => {
	if ("update" in evt.data) {
		multiNoiseCalculator.update(evt.data.update as UpdateMessage)
	} else if ("task" in evt.data) {
		multiNoiseCalculator.addTask(evt.data.task)
	} else if ("cancel" in evt.data) {
		multiNoiseCalculator.removeTask(evt.data.cancel)
	}
}
