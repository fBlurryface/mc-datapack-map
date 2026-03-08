import {
	BiomeSource,
	ChunkPos,
	Climate,
	Identifier,
	LevelHeight,
	NoiseGeneratorSettings,
	StructurePlacement,
	StructureSet,
	WorldgenStructure,
} from "deepslate";
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
const OCEAN_MONUMENT_IDENTIFIER = Identifier.create("minecraft:ocean_monument");

const OCEAN_BIOMES = new Set([
	"minecraft:ocean",
	"minecraft:deep_ocean",
	"minecraft:cold_ocean",
	"minecraft:deep_cold_ocean",
	"minecraft:lukewarm_ocean",
	"minecraft:deep_lukewarm_ocean",
	"minecraft:warm_ocean",
	"minecraft:frozen_ocean",
	"minecraft:deep_frozen_ocean",
]);

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

function getBiomeIdAt(
	biomeSource: BiomeSource,
	sampler: Climate.Sampler,
	x: number,
	y: number,
	z: number,
) {
	return biomeSource.getBiome(x >> 2, y >> 2, z >> 2, sampler).toString();
}

function isLikelyOceanMonumentChunk(
	biomeSource: BiomeSource,
	sampler: Climate.Sampler,
	chunkX: number,
	chunkZ: number,
) {
	const centerX = (chunkX << 4) + 8;
	const centerZ = (chunkZ << 4) + 8;
	const sampleY = 64;

	const samples = [
		getBiomeIdAt(biomeSource, sampler, centerX, sampleY, centerZ),
		getBiomeIdAt(biomeSource, sampler, centerX - 16, sampleY, centerZ),
		getBiomeIdAt(biomeSource, sampler, centerX + 16, sampleY, centerZ),
		getBiomeIdAt(biomeSource, sampler, centerX, sampleY, centerZ - 16),
		getBiomeIdAt(biomeSource, sampler, centerX, sampleY, centerZ + 16),
	];

	let oceanCount = 0;
	let deepOceanCount = 0;

	for (const biome of samples) {
		if (OCEAN_BIOMES.has(biome)) oceanCount += 1;
		if (biome.includes("deep_")) deepOceanCount += 1;
	}

	return oceanCount >= 4 && deepOceanCount >= 1;
}

function toResult(
	setId: Identifier,
	chunk: ChunkPos,
): TerrainSearchResult {
	const x = (chunk[0] << 4) + 8;
	const z = (chunk[1] << 4) + 8;

	return {
		key: `${setId.toString()} ${chunk[0]},${chunk[1]}`,
		tool: OCEAN_MONUMENT_ID,
		structureId: OCEAN_MONUMENT_IDENTIFIER.toString(),
		setId: setId.toString(),
		x,
		y: 62,
		z,
		chunkX: chunk[0],
		chunkZ: chunk[1],
	};
}

export async function locateOceanMonumentsInView(
	options: OceanMonumentLocateOptions,
): Promise<OceanMonumentLocateResponse> {
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
			if (
				isLikelyOceanMonumentChunk(
					options.biomeSource,
					options.sampler,
					chunk[0],
					chunk[1],
				)
			) {
				results.push(toResult(setId, chunk));
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
