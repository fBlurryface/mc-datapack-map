<script setup lang="ts">
import { Identifier } from "deepslate";
import ListDropdown from "./ListDropdown.vue";
import { useLoadedDimensionStore } from "../../stores/useLoadedDimensionStore.js";
import {
	useTerrainSearchStore,
	type TerrainSearchToolId,
} from "../../stores/useTerrainSearchStore.js";

const terrainSearchStore = useTerrainSearchStore();
const loadedDimensionStore = useLoadedDimensionStore();

const entries = [Identifier.create("minecraft:monument")];

function toggleTool(id: Identifier) {
	const key = id.toString() as TerrainSearchToolId;

	if (terrainSearchStore.tools.has(key)) {
		terrainSearchStore.tools.delete(key);
	} else {
		terrainSearchStore.tools.add(key);
	}

	terrainSearchStore.$patch({});
}

function disableGroup(group: string) {
	[...terrainSearchStore.tools].forEach((tool) => {
		if (tool.startsWith(group + ":")) {
			terrainSearchStore.tools.delete(tool);
		}
	});

	terrainSearchStore.$patch({});
}
</script>

<template>
	<ListDropdown
		:type="'structure'"
		:placeholder="'Search terrain tools...'"
		:entries="entries"
		:icons="loadedDimensionStore.getIcon"
		:selected="terrainSearchStore.tools"
		@toggle="toggleTool"
		@disableGroup="disableGroup"
	/>
</template>

<style scoped>
</style>
