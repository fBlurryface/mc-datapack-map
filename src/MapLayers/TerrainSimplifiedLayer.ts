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

  private heightFactor(surface: number, seaLevel: number, maxY: number): number {
    if (!Number.isFinite(surface)) return 0.35
    const denom = Math.max(1, maxY - seaLevel)
    return clamp01((surface - seaLevel) / denom)
  }

  private terrainFactor(terrain: number): number {
    if (!Number.isFinite(terrain)) return 0.5
    return clamp01(0.5 + 0.5 * Math.tanh(terrain / 64))
  }

  private terrainSlopeValue(terrain: number): number {
    if (!Number.isFinite(terrain)) return 0
    return Math.tanh(terrain / 64)
  }

  private landColorByHeight(
    surface: number,
    seaLevel: number,
    maxY: number,
  ): [number, number, number] {
    if (!Number.isFinite(surface)) return [80, 160, 95]

    const t = this.heightFactor(surface, seaLevel, maxY)

    if (t < 0.35) {
      return lerp3([55, 155, 75], [175, 175, 95], t / 0.35)
    }
    if (t < 0.75) {
      return lerp3([175, 175, 95], [125, 125, 125], (t - 0.35) / 0.4)
    }
    return lerp3([125, 125, 125], [245, 245, 245], (t - 0.75) / 0.25)
  }

  private ruggedColor(
    terrain: number,
    surface: number,
    seaLevel: number,
    maxY: number,
  ): [number, number, number] {
    const t = this.terrainFactor(terrain)
    const h = this.heightFactor(surface, seaLevel, maxY)

    let color: [number, number, number]
    if (t < 0.4) {
      color = lerp3([72, 132, 74], [126, 132, 102], t / 0.4)
    } else if (t < 0.75) {
      color = lerp3([126, 132, 102], [170, 170, 170], (t - 0.4) / 0.35)
    } else {
      color = lerp3([170, 170, 170], [235, 235, 235], (t - 0.75) / 0.25)
    }

    if (h > 0.72) {
      color = lerp3(color, [245, 245, 245], clamp01((h - 0.72) / 0.28) * 0.55)
    }

    return color
  }

  private landColor(
    surface: number,
    terrain: number,
    seaLevel: number,
    maxY: number,
  ): [number, number, number] {
    const heightBase = this.landColorByHeight(surface, seaLevel, maxY)
    const ruggedBase = this.ruggedColor(terrain, surface, seaLevel, maxY)

    const h = this.heightFactor(surface, seaLevel, maxY)
    const t = this.terrainFactor(terrain)

    const blend = clamp01(0.18 + t * 0.22 + h * 0.14)

    return lerp3(heightBase, ruggedBase, blend)
  }

  private waterColor(
    surface: number,
    seaLevel: number,
    isRiver: boolean,
  ): [number, number, number] {
    if (!Number.isFinite(surface)) {
      return isRiver ? [45, 170, 245] : [25, 90, 190]
    }

    const depth = clamp01((seaLevel - surface) / 40)

    if (isRiver) {
      return lerp3([70, 190, 240], [28, 112, 170], depth)
    }

    return lerp3([32, 132, 220], [10, 34, 92], depth)
  }

  private beachColor(
    surface: number,
    seaLevel: number,
    terrain: number,
  ): [number, number, number] {
    const h = Number.isFinite(surface)
      ? clamp01((surface - (seaLevel - 2)) / 8)
      : 0.5
    const base = lerp3([202, 194, 146], [232, 223, 181], h)
    const t = this.terrainFactor(terrain)

    return lerp3(base, [176, 166, 130], t * 0.18)
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

  private calculateTerrainShade(tile: Tile, x: number, z: number, isWater: boolean): number {
    if (!tile.array || tile.step === undefined) return 1

    const west = this.getCell(tile, x, z + 1) ?? this.getCell(tile, x + 1, z + 1)
    const east = this.getCell(tile, x + 2, z + 1) ?? this.getCell(tile, x + 1, z + 1)
    const north = this.getCell(tile, x + 1, z) ?? this.getCell(tile, x + 1, z + 1)
    const south = this.getCell(tile, x + 1, z + 2) ?? this.getCell(tile, x + 1, z + 1)

    if (!west || !east || !north || !south) return 1

    const dxSurface =
      (Number.isFinite(east.surface) ? east.surface : 0) -
      (Number.isFinite(west.surface) ? west.surface : 0)
    const dzSurface =
      (Number.isFinite(south.surface) ? south.surface : 0) -
      (Number.isFinite(north.surface) ? north.surface : 0)

    const dxTerrain =
      this.terrainSlopeValue(east.terrain) - this.terrainSlopeValue(west.terrain)
    const dzTerrain =
      this.terrainSlopeValue(south.terrain) - this.terrainSlopeValue(north.terrain)

    const combinedDx = dxSurface + dxTerrain * 10
    const combinedDz = dzSurface + dzTerrain * 10

    let shade = calculateHillshade(combinedDx, combinedDz, tile.step)

    if (isWater) {
      shade = lerp(1, shade, 0.10)
    }

    return shade
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
    const cz0 = Math.floor((zMin - 1 + 1) / 16)
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

        const isRiver = biomeLower.includes("river")
        const isOcean = biomeLower.includes("ocean")
        const isBelowSea = Number.isFinite(surface) && surface <= seaLevel
        const isNearSea =
          Number.isFinite(surface) && surface >= seaLevel - 2 && surface <= seaLevel + 4
        const isBeach =
          biomeLower.includes("beach") ||
          biomeLower.includes("shore") ||
          (!isRiver && !isOcean && !isBelowSea && isNearSea)

        const isWater = isRiver || isOcean || isBelowSea

        let base: [number, number, number]
        if (isRiver) {
          base = this.waterColor(surface, seaLevel, true)
        } else if (isWater) {
          base = this.waterColor(surface, seaLevel, false)
        } else if (isBeach) {
          base = this.beachColor(surface, seaLevel, terrain)
        } else {
          base = this.landColor(surface, terrain, seaLevel, maxY)
        }

        const shade = this.calculateTerrainShade(tile, x, z, isWater)
        const shaded = this.applyShade(base, shade)

        const px = x / this.calcResolution
        const pz = z / this.calcResolution
        const pw = 1 / this.calcResolution
        const ph = 1 / this.calcResolution

        tile.ctx.fillStyle = this.colorToCss(shaded)
        tile.ctx.fillRect(px, pz, pw, ph)

        if (isWater) {
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
        )?.toString() ?? ""
      update.terrainDensityFunctionId =
        getCustomDensityFunction(
          "map_simple_terrain",
          this.loadedDimensionStore.loaded_dimension.noise_settings_id!,
          this.settingsStore.dimension,
        )?.toString() ?? ""
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
