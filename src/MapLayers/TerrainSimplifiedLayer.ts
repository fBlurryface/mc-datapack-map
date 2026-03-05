import * as L from "leaflet"

import { calculateHillshade, getCustomDensityFunction } from "../util.js"
import MultiNoiseCalculator from "../webworker/MultiNoiseCalculator?worker"

import { useLoadedDimensionStore } from "../stores/useLoadedDimensionStore.js"
import { useSettingsStore } from "../stores/useSettingsStore.js"
import { useDatapackStore } from "../stores/useDatapackStore.js"

import { toRaw, watch } from "vue"
import { ResourceLocation } from "mc-datapack-loader"

const WORKER_COUNT = 4

type Tile = {
	coords: L.Coords,
	canvas: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
	done: L.DoneCallback,
	array?: { surface: number, biome: string, terrain: number }[][],
	step?: number,
	isRendering?: boolean,
	workerId: number
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

		// ✅ 必须与 BiomeLayer 一致，保证海岸线/河网结构对齐
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

		// dimension/datapack 更新
		this.loadedDimensionStore.$subscribe(async () => {
			await this.updateWorkers({ settings: true, dimension: true, registires: true })
			this.redraw()
		})

		// seed 更新（保险起见）
		watch(() => this.settingsStore.seed, async () => {
			await this.updateWorkers({ settings: true })
			this.redraw()
		})
	}

	private landColorByHeight(surface: number, seaLevel: number, maxY: number): [number, number, number] {
		if (!Number.isFinite(surface)) return [80, 160, 95]

		// 归一化高度：海平面以上开始计
		const denom = Math.max(1, (maxY - seaLevel))
		const t = clamp01((surface - seaLevel) / denom)

		// 低地绿 -> 高地黄褐 -> 岩灰 -> 雪白
		if (t < 0.35) return lerp3([55, 155, 75], [175, 175, 95], t / 0.35)
		if (t < 0.75) return lerp3([175, 175, 95], [125, 125, 125], (t - 0.35) / 0.4)
		return lerp3([125, 125, 125], [245, 245, 245], (t - 0.75) / 0.25)
	}

	private waterColor(surface: number, seaLevel: number): [number, number, number] {
		// 深水更暗（surface 不可信时就用浅水色）
		if (!Number.isFinite(surface)) return [25, 90, 190]
		const depth = clamp01((seaLevel - surface) / 32)
		return lerp3([25, 110, 210], [8, 25, 70], depth)
	}

	async renderTile(tile: Tile) {
		tile.isRendering = false
		if (tile.array === undefined || tile.step === undefined) return

		const waveImage = await this.waveImage
		tile.ctx.clearRect(0, 0, this.tileSize, this.tileSize)

		const seaLevel = this.loadedDimensionStore.noise_generator_settings.seaLevel
		const level_height = this.loadedDimensionStore.loaded_dimension.level_height ?? { minY: 0, height: 256 }
		const maxY = level_height.minY + level_height.height

		const samples = this.tileSize * this.calcResolution

		for (let x = 0; x < samples; x++) {
			for (let z = 0; z < samples; z++) {
				const cell = tile.array[x + 1][z + 1]
				const biomeLower = cell.biome.toLowerCase()
				const surface = cell.surface

				const isRiver = biomeLower.includes("river")
				const isOcean = biomeLower.includes("ocean")
				const isBeach = biomeLower.includes("beach") || biomeLower.includes("shore")

				let base: [number, number, number]

				if (isRiver) {
					base = [45, 170, 245]
				} else if (isOcean) {
					base = this.waterColor(surface, seaLevel)
				} else if (isBeach) {
					base = [210, 200, 150]
				} else {
					base = this.landColorByHeight(surface, seaLevel, maxY)
				}

				// 只对陆地做 hillshade（避免水面变脏）
				let shade = 1.0
				if (!isOcean && !isRiver) {
					const s00 = tile.array[x + 1][z + 1].surface
					if (Number.isFinite(s00)) {
						const dx = tile.array[x + 2][z + 1].surface - tile.array[x][z + 1].surface
						const dz = tile.array[x + 1][z + 2].surface - tile.array[x + 1][z].surface
						if (Number.isFinite(dx) && Number.isFinite(dz)) {
							shade = calculateHillshade(dx, dz, tile.step)
						}
					}
				}

				const px = x / this.calcResolution
				const pz = z / this.calcResolution
				const pw = 1 / this.calcResolution
				const ph = 1 / this.calcResolution

				tile.ctx.fillStyle = `rgb(${base[0] * shade}, ${base[1] * shade}, ${base[2] * shade})`
				tile.ctx.fillRect(px, pz, pw, ph)

				// 水纹：只按 biome 判断（不信 surface），保证结构一致
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

			// ✅ 跟你 fork 的 BiomeLayer 一致：缺失就是 ""
			update.surfaceDensityFunctionId =
				getCustomDensityFunction("snowcapped_surface", this.loadedDimensionStore.loaded_dimension.noise_settings_id!, this.settingsStore.dimension)?.toString()
				?? ""

			update.terrainDensityFunctionId =
				getCustomDensityFunction("map_simple_terrain", this.loadedDimensionStore.loaded_dimension.noise_settings_id!, this.settingsStore.dimension)?.toString()
				?? ""
		}

		if (do_update.settings) {
			update.seed = this.settingsStore.seed

			// 固定从世界顶端向下投影（不依赖 UI 的 y/project_down）
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
