import { defineStore } from "pinia";
import { reactive, ref } from "vue";

export type TerrainSearchToolId = "minecraft:monument";

export type TerrainSearchResult = {
	key: string;
	tool: TerrainSearchToolId;
	structureId: string;
	setId: string;
	x: number;
	y: number;
	z: number;
	chunkX: number;
	chunkZ: number;
};

export const useTerrainSearchStore = defineStore("terrainSearch", () => {
	const tools = reactive<Set<TerrainSearchToolId>>(new Set());
	const results = ref<TerrainSearchResult[]>([]);
	const loading = ref(false);
	const error = ref<string | null>(null);

	function clear() {
		tools.clear();
		results.value = [];
		loading.value = false;
		error.value = null;
	}

	return {
		tools,
		results,
		loading,
		error,
		clear,
	};
});
