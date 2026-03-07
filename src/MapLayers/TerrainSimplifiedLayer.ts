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

type TileCell = {
  surface: number
  biome: string
  terrain: number
}

type Tile = {
  coords: L.Coords
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  done: L.DoneCallback
  array?: TileCell[][]
  step?: number
  isRendering?: boolean
  workerId: number
  bounds?: {
    west: number
    east: number
    north: number
    south: number
  }
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

function clamp255(v: number) {
  return Math.max(0, Math.min(255, v))
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
  ]
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
  private datapackLoader: Promise<void> | undefined
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

    this.waveImage = new Promise<HTMLImageElement>((resolve) => {
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
    await this.updateWorkers({ settings: true, dimension: true })
    this.redraw()
  }

  private landColorByHeight(
    surface: number,
    seaLevel: number,
    maxY: number,
  ): [number, number, number] {
    if (!Number.isFinite(surface)) return [80, 160, 95]

    const denom = Math.max(1, maxY - seaLevel)
    const t = clamp01((surface - seaLevel) / denom)

    if (t < 0.35) {
      return lerp3([55, 155, 75], [175, 175, 95], t / 0.35)
    }
    if (t < 0.75) {
      return lerp3([175, 175, 95], [125, 125, 125], (t - 0.35) / 0.4)
    }
    return lerp3([125, 125, 125], [245, 245, 245], (t - 0.75) / 0.25)
  }

  private waterColor(surface: number, seaLevel: number): [number, number, number] {
    if (!Number.isFinite(surface)) return [25, 90, 190]

    const depth = clamp01((seaLevel - surface) / 32)
    return lerp3([25, 110, 210], [8, 25, 70], depth)
  }

  private terrainNormalized(terrain: number): number {
    if (!Number.isFinite(terrain)) return 0.5
    return clamp01(0.5 + 0.5 * Math.tanh(terrain / 72))
  }

  private terrainSlope(terrain: number): number {
    if (!Number.isFinite(terrain)) return 0
    return Math.tanh(terrain / 72)
  }

  private landColor(
    surface: number,
    terrain: number,
    seaLevel: number,
    maxY: number,
  ): [number, number, number] {
    const base = this.landColorByHeight(surface, seaLevel, maxY)
    if (!Number.isFinite(terrain)) return base

    const rugged = this.terrainNormalized(terrain)
    const rocky = lerp3([96, 132, 86], [166, 160, 148], rugged)

    const heightT = Number.isFinite(surface)
      ? clamp01((surface - seaLevel) / Math.max(1, maxY - seaLevel))
      : 0.5

    const blend = clamp01(0.08 + rugged * 0.16 + heightT * 0.05)
    return lerp3(base, rocky, blend)
  }

  private applyShade(
    color: [number, number, number],
    shade: number,
  ): [number, number, number] {
    return [
      clamp255(color[0] * shade),
      clamp255(color[1] * shade),
      clamp255(color[2] * shade),
    ]
  }

  private colorToCss(color: [number, number, number]): string {
    return `rgb(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])})`
  }

  private getCell(tile: Tile, x: number, z: number): TileCell | undefined {
    return tile.array?.[x]?.[z]
  }

  private calculateSurfaceShade(tile: Tile, x: number, z: number): number {
    if (!tile.array || tile.step === undefined) return 1

    const center = this.getCell(tile, x + 1, z + 1)
    if (!center || !Number.isFinite(center.surface)) return 1

    const west = this.getCell(tile, x, z + 1)
    const east = this.getCell(tile, x + 2, z + 1)
    const north = this.getCell(tile, x + 1, z)
    const south = this.getCell(tile, x + 1, z + 2)

    if (!west || !east || !north || !south) return 1
    if (
      !Number.isFinite(west.surface) ||
      !Number.isFinite(east.surface) ||
      !Number.isFinite(north.surface) ||
      !Number.isFinite(south.surface)
    ) {
      return 1
    }

    const dx = east.surface - west.surface
    const dz = south.surface - north.surface
    return calculateHillshade(dx, dz, tile.step)
  }

  private calculateTerrainShade(tile: Tile, x: number, z: number): number {
    if (!tile.array || tile.step === undefined) return 1

    const west = this.getCell(tile, x, z + 1)
    const east = this.getCell(tile, x + 2, z + 1)
    const north = this.getCell(tile, x + 1, z)
    const south = this.getCell(tile, x + 1, z + 2)

    if (!west || !east || !north || !south) return 1
    if (
      !Number.isFinite(west.terrain) ||
      !Number.isFinite(east.terrain) ||
      !Number.isFinite(north.terrain) ||
      !Number.isFinite(south.terrain)
    ) {
      return 1
    }

    const dx = this.terrainSlope(east.terrain) - this.terrainSlope(west.terrain)
    const dz = this.terrainSlope(south.terrain) - this.terrainSlope(north.terrain)

    return calculateHillshade(dx * 18, dz * 18, tile.step)
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
    const level_height = this.loadedDimensionStore.loaded_dimension.level_height ?? {
      minY: 0,
      height: 256,
    }
    const maxY = level_height.minY + level_height.height
    const samples = this.tileSize * this.calcResolution

    for (let x = 0; x < samples; x++) {
      for (let z = 0; z < samples; z++) {
        const cell = tile.array[x + 1][z + 1]
        const biomeLower = cell.biome.toLowerCase()
        const surface = cell.surface
        const terrain = cell.terrain

        // 这里严格保留原本正确的海陆轮廓判定
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
          base = this.landColor(surface, terrain, seaLevel, maxY)
        }

        let shade = 1.0
        if (!isOcean && !isRiver) {
          const surfaceShade = this.calculateSurfaceShade(tile, x, z)

          if (!isBeach && Number.isFinite(terrain)) {
            const terrainShade = this.calculateTerrainShade(tile, x, z)
            shade = lerp(surfaceShade, terrainShade, 0.22)
          } else {
            shade = surfaceShade
          }
        }

        const shaded = this.applyShade(base, shade)

        const px = x / this.calcResolution
        const pz = z / this.calcResolution
        const pw = 1 / this.calcResolution
        const ph = 1 / this.calcResolution

        tile.ctx.fillStyle = this.colorToCss(shaded)
        tile.ctx.fillRect(px, pz, pw, ph)

        if (isOcean || isRiver) {
          tile.ctx.drawImage(
            waveImage,
            px % 16,
            pz % 16,
            4,
            4,
            px,
            pz,
            4,
            4,
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

        void this.renderTile(tile)

        tile.done()
        tile.done = () => {
          // nothing
        }
      }

      this.workers.push(worker)
    }
  }

  async updateWorkers(do_update: {
    registires?: boolean
    dimension?: boolean
    settings?: boolean
  }) {
    this.generationVersion++

    const update: any = { generationVersion: this.generationVersion }

    if (do_update.registires) {
      update.densityFunctions = {}
      for (const id of await this.datapackStore.composite_datapack.getIds(
        ResourceLocation.WORLDGEN_DENSITY_FUNCTION,
      )) {
        update.densityFunctions[id.toString()] =
          await this.datapackStore.composite_datapack.get(
            ResourceLocation.WORLDGEN_DENSITY_FUNCTION,
            id,
          )
      }

      update.noises = {}
      for (const id of await this.datapackStore.composite_datapack.getIds(
        ResourceLocation.WORLDGEN_NOISE,
      )) {
        update.noises[id.toString()] =
          await this.datapackStore.composite_datapack.get(
            ResourceLocation.WORLDGEN_NOISE,
            id,
          )
      }
    }

    if (do_update.dimension) {
      update.biomeSourceJson = toRaw(this.loadedDimensionStore.loaded_dimension.biome_source_json)
      update.noiseGeneratorSettingsJson = toRaw(
        this.loadedDimensionStore.loaded_dimension.noise_settings_json,
      )

      update.surfaceDensityFunctionId =
        getCustomDensityFunction(
          "snowcapped_surface",
          this.loadedDimensionStore.loaded_dimension.noise_settings_id!,
          this.settingsStore.dimension,
        )?.toString() ?? "<none>"

      update.terrainDensityFunctionId =
        getCustomDensityFunction(
          "map_simple_terrain",
          this.loadedDimensionStore.loaded_dimension.noise_settings_id!,
          this.settingsStore.dimension,
        )?.toString() ?? "<none>"
    }

    if (do_update.settings) {
      update.seed = this.settingsStore.seed
      const level_height = this.loadedDimensionStore.loaded_dimension.level_height ?? {
        minY: 0,
        height: 256,
      }
      update.y = level_height.minY + level_height.height
      update.project_down = true
    }

    this.workers.forEach((w) => w.postMessage({ update }))
  }

  generateTile(key: string, coords: L.Coords, worker_id: number) {
    // @ts-expect-error: _tileCoordsToBounds does not exist
    const tileBounds = this._tileCoordsToBounds(coords)

    const west = tileBounds.getWest()
    const east = tileBounds.getEast()
    const north = tileBounds.getNorth()
    const south = tileBounds.getSouth()

    this.Tiles[key].bounds = { west, east, north, south }

    const crs = this._map.options.crs!
    const min = crs.project(L.latLng(north, west)).multiplyBy(0.25)
    const max = crs.project(L.latLng(south, east)).multiplyBy(0.25)

    min.y *= -1
    max.y *= -1

    const task = {
      key,
      min,
      max,
      tileSize: this.tileSize * this.calcResolution,
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
      this.Tiles[key] = {
        coords,
        canvas: tileEl,
        ctx,
        done,
        workerId: this.next_worker_id,
      }

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
