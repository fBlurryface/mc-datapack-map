import * as L from "leaflet"
import { calculateHillshade, getCustomDensityFunction } from "../util.js"
import MultiNoiseCalculator from "../webworker/MultiNoiseCalculator?worker"

import { useLoadedDimensionStore } from "../stores/useLoadedDimensionStore.js"
import { useSettingsStore } from "../stores/useSettingsStore.js"
import { useDatapackStore } from "../stores/useDatapackStore.js"

import { toRaw } from "vue"
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

function clamp01(v: number) {
	return Math.max(0, Math.min(1, v))
}

function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
	return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

export class TerrainOnlyLayer extends L.GridLayer {
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

		// ✅ 必须与 BiomeLayer 保持一致：1/4（对应 quart 网格，避免 biome 偏位）
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

		// seed / dimension / datapack 变化都会触发 loadedDimensionStore reload
		this.loadedDimensionStore.$subscribe(async () => {
			await this.updateWorkers({
				settings: true,
				dimension: true,
				registires: true
			})
			this.redraw()
		})
	}

	// === coloring (height + rivers + oceans + water) ===
	private terrainColor(surface: number, biomeId: string, seaLevel: number, maxY: number): [number, number, number] {
		const id = biomeId.toLowerCase()

		const isRiver = id.includes("river")
		const isOcean = id.includes("ocean")

		// rivers: highlight blue
		if (isRiver) return [40, 150, 245]

		// shoreline band (helps visual sea boundary)
		if (Number.isFinite(surface) && Math.abs(surface - seaLevel) <= 1.5) return [220, 210, 165]

		// water by biome OR by height
		if (isOcean || (Number.isFinite(surface) && surface <= seaLevel)) {
			const depth = Number.isFinite(surface) ? clamp01((seaLevel - surface) / 32) : 0
			return lerp3([25, 120, 210], [8, 25, 70], depth)
		}

		// unknown surface -> white
		if (!Number.isFinite(surface)) return [255, 255, 255]

		// land: low green -> high yellow/brown -> rock gray -> snow white
		const denom = Math.max(1, (maxY - seaLevel))
		const t = clamp01((surface - seaLevel) / denom)

		if (t < 0.35) return lerp3([45, 150, 70], [170, 175, 95], t / 0.35)
		if (t < 0.75) return lerp3([170, 175, 95], [125, 125, 125], (t - 0.35) / 0.4)
		return lerp3([125, 125, 125], [245, 245, 245], (t - 0.75) / 0.25)
	}

	// ===== Draw tiles =====
	async renderTile(tile: Tile) {
		tile.isRendering = false

		if (tile.array === undefined || tile.step === undefined) {
			console.warn("trying to render empty tile")
			return
		}

		tile.ctx.clearRect(0, 0, this.tileSize, this.tileSize)
		const waveImage = await this.waveImage

		const seaLevel = this.loadedDimensionStore.noise_generator_settings.seaLevel
		const level_height = this.loadedDimensionStore.loaded_dimension.level_height ?? { minY: 0, height: 256 }
		const maxY = level_height.minY + level_height.height

		const samples = this.tileSize * this.calcResolution

		for (let x = 0; x < samples; x++) {
			for (let z = 0; z < samples; z++) {
				const cell = tile.array[x + 1][z + 1]
				const surface = cell.surface
				const biome = cell.biome
				const biomeLower = biome.toLowerCase()

				let hillshade = 1.0
				if (Number.isFinite(surface)) {
					const dx = tile.array[x + 2][z + 1].surface - tile.array[x][z + 1].surface
					const dz = tile.array[x + 1][z + 2].surface - tile.array[x + 1][z].surface
					if (Number.isFinite(dx) && Number.isFinite(dz)) {
						hillshade = calculateHillshade(dx, dz, tile.step)
					}
				}

				const [r, g, b] = this.terrainColor(surface, biome, seaLevel, maxY)

				const px = x / this.calcResolution
				const pz = z / this.calcResolution
				const pw = 1 / this.calcResolution
				const ph = 1 / this.calcResolution

				tile.ctx.fillStyle = `rgb(${r * hillshade}, ${g * hillshade}, ${b * hillshade})`
				tile.ctx.fillRect(px, pz, pw, ph)

				// water wave overlay: ocean/river biome OR below sea level
				const isWaterBiome = biomeLower.includes("ocean") || biomeLower.includes("river")
				const isBelowSea = Number.isFinite(surface) && surface < seaLevel - 2

				if (isWaterBiome || isBelowSea) {
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

		// slime chunks overlay: only overworld + zoom close enough
		const overworld = this.settingsStore.dimension.toString() === "minecraft:overworld"
		const zoomOk = (this._map !== undefined) && (this._map.getZoom() >= -3)

		if (overworld && zoomOk && tile.bounds !== undefined) {
			const { west, east, north, south } = tile.bounds

			const xMin = west
			const xMax = east
			const zMin = -north
			const zMax = -south

			const cx0 = Math.floor(xMin / 16)
			const cx1 = Math.floor((xMax - 1) / 16)
			const cz0 = Math.floor(zMin / 16)
			const cz1 = Math.floor((zMax - 1) / 16)

			const w = xMax - xMin
			const h = zMax - zMin

			tile.ctx.fillStyle = "rgba(120, 0, 255, 0.16)"
			tile.ctx.strokeStyle = "rgba(120, 0, 255, 0.40)"
			tile.ctx.lineWidth = 1

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

					tile.ctx.fillRect(px0, py0, pw, ph)
					tile.ctx.strokeRect(px0, py0, pw, ph)
				}
			}
		}
	}

	// ==== Manage workers ====
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

			// ✅ 关键：缺失时必须是 ""（BiomeLayer 就是这样传的）
			update.surfaceDensityFunctionId =
				getCustomDensityFunction("snowcapped_surface", this.loadedDimensionStore.loaded_dimension.noise_settings_id!, this.settingsStore.dimension)?.toString()
				?? ""

			update.terrainDensityFunctionId =
				getCustomDensityFunction("map_simple_terrain", this.loadedDimensionStore.loaded_dimension.noise_settings_id!, this.settingsStore.dimension)?.toString()
				?? ""
		}

		if (do_update.settings) {
			update.seed = this.settingsStore.seed

			// Terrain-only: always project down from the top of the world
			const level_height = this.loadedDimensionStore.loaded_dimension.level_height ?? { minY: 0, height: 256 }
			update.y = level_height.minY + level_height.height
			update.project_down = true
		}

		this.workers.forEach(w => w.postMessage({ update }))
	}

	generateTile(key: string, coords: L.Coords, worker_id: number) {
		// @ts-expect-error: _tileCoordsToBounds does not exist
		const tileBounds = this._tileCoordsToBounds(coords)
		const west = tileBounds.getWest(),
			east = tileBounds.getEast(),
			north = tileBounds.getNorth(),
			south = tileBounds.getSouth()

		// store bounds for slime overlay mapping
		this.Tiles[key].bounds = { west, east, north, south }

		const crs = this._map.options.crs!,
			min = crs.project(L.latLng(north, west)).multiplyBy(0.25),
			max = crs.project(L.latLng(south, east)).multiplyBy(0.25)

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
		const tile = L.DomUtil.create("canvas", "leaflet-tile")
		tile.width = tile.height = this.tileSize
		tile.onselectstart = tile.onmousemove = L.Util.falseFn

		const ctx = tile.getContext("2d")!
		if (!this._map) return tile

		this.datapackLoader?.then(() => {
			const key = this._tileCoordsToKey(coords)
			this.Tiles[key] = { coords: coords, canvas: tile, ctx: ctx, done: done, workerId: this.next_worker_id }

			this.generateTile(key, coords, this.next_worker_id)
			this.next_worker_id = (this.next_worker_id + 1) % WORKER_COUNT
		})

		return tile
	}

	_removeTile(key: string) {
		if (this.Tiles[key] === undefined) return

		this.workers[this.Tiles[key].workerId].postMessage({ cancel: key })
		delete this.Tiles[key]

		// @ts-expect-error: _removeTile does not exist
		L.TileLayer.prototype._removeTile.call(this, key)
	}
}
