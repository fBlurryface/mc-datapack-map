import {
	BiomeSource,
	BlockPos,
	ChunkPos,
	Climate,
	Identifier,
	LevelHeight,
	NoiseGeneratorSettings,
	StructurePlacement,
	StructureSet,
	WorldgenStructure,
} from "deepslate";
import { CachedBiomeSource } from "../CachedBiomeSource.js";
import type {
	TerrainSearchResult,
	TerrainSearchToolId,
} from "../../stores/useTerrainSearchStore.js";

export type OceanMonumentLocateOptions = {
	seed: bigint;
	zoom: number;
	minChunk: ChunkPos;
	maxChunk: ChunkPos;
	biomeSource: BiomeSource;
	sampler: Climate.Sampler;
	noiseGeneratorSettings: NoiseGeneratorSettings;
	levelHeight: LevelHeight;
};

export type OceanMonumentLocateResponse = {
	results: TerrainSearchResult[];
	needsZoom: boolean;
};

const OCEAN_MONUMENT_ID = "minecraft:ocean_monument" as TerrainSearchToolId;

function isOceanMonumentSet(set: StructureSet) {
	return set.structures.some((entry) => {
		const structure = entry.structure.value();
		return structure instanceof WorldgenStructure.OceanMonumentStructure;
	});
}

function getMinZoomForSet(
	set: StructureSet,
	biomeSource: BiomeSource,
	sampler: Climate.Sampler,
	seed: bigint,
) {
	let minZoom = 2;

	if (set.placement instanceof StructurePlacement.ConcentricRingsStructurePlacement) {
		set.placement.prepare(biomeSource, sampler, seed);
		minZoom = -2;
	} else if (set.placement instanceof StructurePlacement.RandomSpreadStructurePlacement) {
		const chunkFrequency =
			set.placement.frequency / (set.placement.spacing * set.placement.spacing);
		minZoom = -Math.log2(1 / (chunkFrequency * 128));
	}

	return minZoom;
}

function toResult(
	setId: Identifier,
	structureId: Identifier,
	pos: BlockPos,
	chunk: ChunkPos,
): TerrainSearchResult {
	return {
		key: `${setId.toString()} ${chunk[0]},${chunk[1]}`,
		tool: OCEAN_MONUMENT_ID,
		structureId: structureId.toString(),
		setId: setId.toString(),
		x: pos[0],
		y: pos[1],
		z: pos[2],
		chunkX: chunk[0],
		chunkZ: chunk[1],
	};
}

export async function locateOceanMonumentsInView(
	options: OceanMonumentLocateOptions,
): Promise<OceanMonumentLocateResponse> {
	const cachedBiomeSource = new CachedBiomeSource(options.biomeSource);
	const context = new WorldgenStructure.GenerationContext(
		options.seed,
		cachedBiomeSource,
		options.noiseGeneratorSettings,
		options.levelHeight,
	);

	const results: TerrainSearchResult[] = [];
	let needsZoom = false;
	let workCounter = 0;

	for (const setId of StructureSet.REGISTRY.keys()) {
		const set = StructureSet.REGISTRY.get(setId);
		if (!set || !isOceanMonumentSet(set)) continue;

		const minZoom = getMinZoomForSet(
			set,
			options.biomeSource,
			options.sampler,
			options.seed,
		);

		if (options.zoom < minZoom) {
			needsZoom = true;
			continue;
		}

		const chunks = set.placement.getPotentialStructureChunks(
			options.seed,
			options.minChunk[0],
			options.minChunk[1],
			options.maxChunk[0],
			options.maxChunk[1],
		);

		for (const chunk of chunks) {
			cachedBiomeSource.setupCache(chunk[0] << 2, chunk[1] << 2);

			try {
				const structure = set.getStructureInChunk(chunk[0], chunk[1], context);
				if (!structure) continue;
				if (structure.id.toString() !== OCEAN_MONUMENT_ID) continue;

				results.push(toResult(setId, structure.id, structure.pos, chunk));
			} catch {
				// 保持单个候选点失败不影响整次刷新
			}

			workCounter += 1;
			if (workCounter % 64 === 0) {
				await Promise.resolve();
			}
		}
	}

	const unique = new Map<string, TerrainSearchResult>();
	for (const result of results) {
		unique.set(result.key, result);
	}

	return {
		results: [...unique.values()],
		needsZoom,
	};
}
