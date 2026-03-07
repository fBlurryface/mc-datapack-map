import * as L from "leaflet"

import { calculateHillshade, getCustomDensityFunction } from "../util.js"
import MultiNoiseCalculator from "../webworker/MultiNoiseCalculator?worker"

import { useLoadedDimensionStore } from "../stores/useLoadedDimensionStore.js"
import { useSettingsStore } from "../stores/useSettingsStore.js"
import { useDatapackStore } from "../stores/useDatapackStore.js"

import { toRaw, watch } from "vue"
import { ResourceLocation } from "mc-datapack-loader"

import { isSlimeChunk } from "../util/SlimeChunks.js"

const WORKER_COUNT = 4

type Tile = {
	coords: L.Coords,
	canvas: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
	done: L.DoneCallback,
	array?: { surface: number, biome: string, terrain: number }[][],
	step?: number,
	isRendering?: boolean,
	workerId: number,
	bounds?: { west: number, east: number, north: number, south: number }
}

type RGB = [number, number, number]

function clamp01(v: number) {
	return Math.max(0, Math.min(1, v))
}

function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t
}

function lerp3(a: RGB, b: RGB, t: number): RGB {
	return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

function clampColor(c: RGB): RGB {
	return [
		Math.max(0, Math.min(255, c[0])),
		Math.max(0, Math.min(255, c[1])),
		Math.max(0, Math.min(255, c[2]))
	]
}

function mulColor(c: RGB, m: number): RGB {
	return clampColor([c[0] * m, c[1] * m, c[2] * m])
}

function mixColor(a: RGB, b: RGB, t: number): RGB {
	return clampColor(lerp3(a, b, clamp01(t)))
}

function hasAny(text: string, parts: string[]) {
	return parts.some(p => text.includes(p))
}

export class TerrainSimplifiedLayer extends L.GridLayer {
	private next_worker_id = 0
	private Tiles: { [key: string]: Tile } = {}

	private tileSize = 0
	private calcResolution = 0

	private workers: Worker[] = []

	private datapackStore = useDatapackStore()
	private loadedDimensionStore = useLoadedDimensionStore()
	private settingsStore = useSettingsStore()

	private datapackLoader: Promise<any> | undefined
	private generationVersion = 0

	private waveImage: Promise<HTMLImageElement>

	constructor(options: L.GridLayerOptions) {
		super(options)

		this.tileSize = options.tileSize as number
		this.calcResolution = 1 / 4

		this.createWorkers()

		this.datapackLoader = this.updateWorkers({
			dimension: true,
			registires: true,
			settings: true,
		})

		this.waveImage = new Promise((resolve) => {
			const waveImage = new Image()
			waveImage.onload = () => resolve(waveImage)
			waveImage.src = "images/wave.png"
		})

		this.loadedDimensionStore.$subscribe(async () => {
			await this.updateWorkers({ settings: true, dimension: true, registires: true })
			this.redraw()
		})

		watch(() => this.settingsStore.seed, async () => {
			await this.updateWorkers({ settings: true })
			this.redraw()
		})
	}

	public override onAdd(map: L.Map): this {
		super.onAdd(map)
		void this.refreshForCurrentSettings()
		return this
	}

	public async refreshForCurrentSettings() {
		await this.datapackLoader
		await this.updateWorkers({
			settings: true,
			dimension: true
		})
		this.redraw()
	}

	private waterColor(surface: number, seaLevel: number, biomeLower: string): RGB {
		const isRiver = biomeLower.includes("river")
		const isOcean = biomeLower.includes("ocean")
		const isFrozen = hasAny(biomeLower, ["frozen", "snowy", "ice"])

		if (isRiver) {
			return isFrozen ? [150, 190, 220] : [55, 165, 240]
		}

		const depth = Number.isFinite(surface) ? Math.max(0, seaLevel - surface) : 0
		const isDeep = biomeLower.includes("deep_ocean") || depth >= 36
		const isVeryDeep = depth >= 64

		let base: RGB

		// continental shelf / shallow water
		if (depth <= 6) {
			base = isFrozen ? [160, 205, 225] : [75, 165, 215]
		}
		// regular ocean
		else if (!isDeep) {
			const t = clamp01((depth - 6) / 26)
			base = isFrozen
				? lerp3([150, 195, 220], [78, 120, 170], t)
				: lerp3([60, 145, 210], [20, 70, 150], t)
		}
		// deep ocean
		else {
			const t = clamp01((depth - 36) / 48)
			base = isFrozen
				? lerp3([90, 125, 170], [36, 60, 95], t)
				: lerp3([18, 62, 145], [5, 18, 60], t)

			if (isVeryDeep) {
				base = mixColor(base, isFrozen ? [18, 28, 42] : [3, 8, 28], 0.35)
			}
		}

		if (isOcean && biomeLower.includes("warm")) {
			base = mixColor(base, [40, 170, 185], 0.15)
		}

		return clampColor(base)
	}

	private landColorByHeight(surface: number, seaLevel: number, biomeLower: string, slope: number): RGB {
		if (!Number.isFinite(surface)) return [92, 150, 92]

		const snowy = hasAny(biomeLower, ["snowy", "frozen", "ice", "peaks", "grove", "slopes"])
		const desert = hasAny(biomeLower, ["desert", "badlands"])
		const warmDry = hasAny(biomeLower, ["savanna"])
		const lush = hasAny(biomeLower, ["jungle", "forest", "taiga"])

		let base: RGB

		// 低地 / 海岸附近
		if (surface <= seaLevel + 6) {
			base = desert ? [188, 170, 112] : [98, 148, 88]
		}
		// 平原/低丘
		else if (surface <= 90) {
			base = desert ? [182, 156, 98] : lush ? [72, 132, 76] : [108, 145, 84]
		}
		// 丘陵
		else if (surface <= 118) {
			base = desert ? [172, 142, 92] : warmDry ? [144, 136, 78] : [132, 142, 86]
		}
		// 高地
		else if (surface <= 140) {
			base = desert ? [162, 132, 92] : [146, 132, 94]
		}
		// 亚高山 / 裸岩开始
		else if (surface <= 165) {
			base = snowy ? [138, 142, 150] : [128, 124, 120]
		}
		// 雪线以上
		else if (surface <= 195) {
			base = snowy ? [225, 233, 240] : [208, 208, 206]
		}
		// 极高峰
		else {
			base = snowy ? [244, 247, 250] : [230, 230, 228]
		}

		// 高海拔陡坡强化：让山脊更明显
		if (surface > 120) {
			const ridge = clamp01((surface - 120) / 70) * slope
			base = mixColor(base, snowy ? [248, 250, 252] : [220, 220, 220], ridge * 0.6)
		}

		// 雪地/雪峰 biome 在高处更偏冷白
		if (snowy && surface > 135) {
			const snowiness = clamp01((surface - 135) / 35)
			base = mixColor(base, [240, 245, 250], snowiness * 0.55)
		}

		return clampColor(base)
	}

	private drawSlimeOverlay(tile: Tile) {
		if (this.settingsStore.dimension.toString() !== "minecraft:overworld") return
		if (!this._map) return
		if (this._map.getZoom() < -3) return
		if (!tile.bounds) return

		const { west, east, north, south } = tile.bounds

		const xMin = west
		const xMax = east
		const zMin = -north
		const zMax = -south

		const w = xMax - xMin
		const h = zMax - zMin
		if (w <= 0 || h <= 0) return

		const cx0 = Math.floor(xMin / 16)
		const cx1 = Math.floor((xMax - 1) / 16)
		const cz0 = Math.floor(zMin / 16)
		const cz1 = Math.floor((zMax - 1) / 16)

		const ctx = tile.ctx
		ctx.save()
		ctx.fillStyle = "rgba(120, 0, 255, 0.16)"
		ctx.strokeStyle = "rgba(120, 0, 255, 0.40)"
		ctx.lineWidth = 1

		const seed = this.settingsStore.seed

		for (let cx = cx0; cx <= cx1; cx++) {
			for (let cz = cz0; cz <= cz1; cz++) {
				if (!isSlimeChunk(seed, cx, cz)) continue

				const bx0 = cx * 16
				const bz0 = cz * 16

				const px0 = ((bx0 - xMin) / w) * this.tileSize
				const py0 = ((bz0 - zMin) / h) * this.tileSize
				const pw = (16 / w) * this.tileSize
				const ph = (16 / h) * this.tileSize

				ctx.fillRect(px0, py0, pw, ph)
				ctx.strokeRect(px0, py0, pw, ph)
			}
		}

		ctx.restore()
	}

	async renderTile(tile: Tile) {
		tile.isRendering = false
		if (tile.array === undefined || tile.step === undefined) return

		const waveImage = await this.waveImage
		tile.ctx.clearRect(0, 0, this.tileSize, this.tileSize)

		const seaLevel = this.loadedDimensionStore.noise_generator_settings.seaLevel

		const samples = this.tileSize * this.calcResolution

		for (let x = 0; x < samples; x++) {
			for (let z = 0; z < samples; z++) {
				const cell = tile.array[x + 1][z + 1]
				const biomeLower = cell.biome.toLowerCase()
				const surface = cell.surface

				const isRiver = biomeLower.includes("river")
				const isOcean = biomeLower.includes("ocean")
				const isBeach = biomeLower.includes("beach") || biomeLower.includes("shore")

				let dx = 0
				let dz = 0
				let slope = 0
				if (Number.isFinite(surface)) {
					dx = tile.array[x + 2][z + 1].surface - tile.array[x][z + 1].surface
					dz = tile.array[x + 1][z + 2].surface - tile.array[x + 1][z].surface
					if (Number.isFinite(dx) && Number.isFinite(dz)) {
						// 纯经验缩放，目的只是让“陡坡/山脊”更容易被看出来
						slope = clamp01(Math.hypot(dx, dz) / 36)
					}
				}

				let base: RGB
				if (isRiver) {
					base = this.waterColor(surface, seaLevel, biomeLower)
				} else if (isOcean || surface <= seaLevel - 2) {
					base = this.waterColor(surface, seaLevel, biomeLower)
				} else if (isBeach) {
					base = [210, 198, 150]
				} else {
					base = this.landColorByHeight(surface, seaLevel, biomeLower, slope)
				}

				let shade = 1.0
				if (!isOcean && !isRiver && Number.isFinite(surface)) {
					if (Number.isFinite(dx) && Number.isFinite(dz)) {
						shade = calculateHillshade(dx, dz, tile.step)
					}
				}

				const px = x / this.calcResolution
				const pz = z / this.calcResolution
				const pw = 1 / this.calcResolution
				const ph = 1 / this.calcResolution

				const finalColor = mulColor(base, shade)
				tile.ctx.fillStyle = `rgb(${finalColor[0]}, ${finalColor[1]}, ${finalColor[2]})`
				tile.ctx.fillRect(px, pz, pw, ph)

				if (isOcean || isRiver) {
					tile.ctx.drawImage(
						waveImage,
						(px % 16),
						(pz % 16),
						4, 4,
						px,
						pz,
						4, 4
					)
				}
			}
		}

		this.drawSlimeOverlay(tile)
	}

	private createWorkers() {
		this.workers = []
		for (let i = 0; i < WORKER_COUNT; i++) {
			const worker = new MultiNoiseCalculator()
			worker.onmessage = (ev) => {
				if (ev.data.generationVersion < this.generationVersion) return

				const tile = this.Tiles[ev.data.key]
				if (tile === undefined) return

				tile.array = ev.data.array
				tile.step = ev.data.step

				tile.isRendering = true
				this.renderTile(tile)

				tile.done()
				tile.done = () => { /* nothing */ }
			}
			this.workers.push(worker)
		}
	}

	async updateWorkers(do_update: { registires?: boolean, dimension?: boolean, settings?: boolean }) {
		this.generationVersion++
		const update: any = { generationVersion: this.generationVersion }

		if (do_update.registires) {
			update.densityFunctions = {}
			for (const id of await this.datapackStore.composite_datapack.getIds(ResourceLocation.WORLDGEN_DENSITY_FUNCTION)) {
				update.densityFunctions[id.toString()] = await this.datapackStore.composite_datapack.get(ResourceLocation.WORLDGEN_DENSITY_FUNCTION, id)
			}

			update.noises = {}
			for (const id of await this.datapackStore.composite_datapack.getIds(ResourceLocation.WORLDGEN_NOISE)) {
				update.noises[id.toString()] = await this.datapackStore.composite_datapack.get(ResourceLocation.WORLDGEN_NOISE, id)
			}
		}

		if (do_update.dimension) {
			update.biomeSourceJson = toRaw(this.loadedDimensionStore.loaded_dimension.biome_source_json)
			update.noiseGeneratorSettingsJson = toRaw(this.loadedDimensionStore.loaded_dimension.noise_settings_json)

			update.surfaceDensityFunctionId =
				getCustomDensityFunction("snowcapped_surface", this.loadedDimensionStore.loaded_dimension.noise_settings_id!, this.settingsStore.dimension)?.toString()
				?? ""

			update.terrainDensityFunctionId =
				getCustomDensityFunction("map_simple_terrain", this.loadedDimensionStore.loaded_dimension.noise_settings_id!, this.settingsStore.dimension)?.toString()
				?? ""
		}

		if (do_update.settings) {
			update.seed = this.settingsStore.seed

			const level_height = this.loadedDimensionStore.loaded_dimension.level_height ?? { minY: 0, height: 256 }
			update.y = level_height.minY + level_height.height
			update.project_down = true
		}

		this.workers.forEach(w => w.postMessage({ update }))
	}

	generateTile(key: string, coords: L.Coords, worker_id: number) {
		// @ts-expect-error: _tileCoordsToBounds does not exist
		const tileBounds = this._tileCoordsToBounds(coords);

		const west = tileBounds.getWest(),
			east = tileBounds.getEast(),
			north = tileBounds.getNorth(),
			south = tileBounds.getSouth();

		this.Tiles[key].bounds = { west, east, north, south }

		const crs = this._map.options.crs!,
			min = crs.project(L.latLng(north, west)).multiplyBy(0.25),
			max = crs.project(L.latLng(south, east)).multiplyBy(0.25);

		min.y *= -1
		max.y *= -1

		const task = {
			key,
			min,
			max,
			tileSize: this.tileSize * this.calcResolution
		}

		this.workers[worker_id].postMessage({ task })
	}

	createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
		const tileEl = L.DomUtil.create("canvas", "leaflet-tile") as HTMLCanvasElement
		tileEl.width = tileEl.height = this.tileSize
		tileEl.onselectstart = tileEl.onmousemove = L.Util.falseFn

		const ctx = tileEl.getContext("2d")!
		if (!this._map) return tileEl

		this.datapackLoader?.then(() => {
			const key = this._tileCoordsToKey(coords)
			this.Tiles[key] = { coords: coords, canvas: tileEl, ctx: ctx, done: done, workerId: this.next_worker_id }

			this.generateTile(key, coords, this.next_worker_id)
			this.next_worker_id = (this.next_worker_id + 1) % WORKER_COUNT
		})

		return tileEl
	}

	_removeTile(key: string) {
		if (this.Tiles[key] === undefined) return

		this.workers[this.Tiles[key].workerId].postMessage({ cancel: key })
		delete this.Tiles[key]

		// @ts-expect-error: _removeTile does not exist
		L.TileLayer.prototype._removeTile.call(this, key)
	}
}
