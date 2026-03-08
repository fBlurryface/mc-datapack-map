import {
	BiomeSource,
	ChunkPos,
	Climate,
	Identifier,
	LevelHeight,
	NoiseGeneratorSettings,
	StructurePlacement,
	StructureSet,
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

const TOOL_ID = "minecraft:monument" as TerrainSearchToolId;
const MONUMENT_STRUCTURE_KEYS = new Set([
	"minecraft:monument",
	"minecraft:ocean_monument",
]);

function getOceanMonumentStructureId(set: StructureSet): Identifier | undefined {
	for (const entry of set.structures) {
		const key = entry.structure.key()?.toString();
		if (key && MONUMENT_STRUCTURE_KEYS.has(key)) {
			return entry.structure.key();
		}
	}
	return undefined;
}

function isOceanMonumentSet(set: StructureSet) {
	return getOceanMonumentStructureId(set) !== undefined;
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
	chunk: ChunkPos,
): TerrainSearchResult {
	const x = (chunk[0] << 4) + 8;
	const z = (chunk[1] << 4) + 8;

	return {
		key: `${setId.toString()} ${chunk[0]},${chunk[1]}`,
		tool: TOOL_ID,
		structureId: structureId.toString(),
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
		if (!set) continue;

		const structureId = getOceanMonumentStructureId(set);
		if (!structureId) continue;

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
			results.push(toResult(setId, structureId, chunk));

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
