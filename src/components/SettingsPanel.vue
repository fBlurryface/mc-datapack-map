<script setup lang="ts">
import { XoroshiroRandom } from 'deepslate';
import { ref } from 'vue';

import { useDatapackStore } from '../stores/useDatapackStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { parseSeed, versionMetadata } from '../util'

import { useI18n } from 'vue-i18n';

const i18n = useI18n()

const datapackStore = useDatapackStore();
const settingsStore = useSettingsStore()

const dimensions = ref(await datapackStore.dimensions)
const world_presets = ref(await datapackStore.world_presets)

const random = XoroshiroRandom.create(BigInt(Date.now()))

datapackStore.$subscribe(async () => {
	world_presets.value = await datapackStore.world_presets
	dimensions.value = await datapackStore.dimensions
})

function randomizeSeed() {
	settingsStore.seed = random.nextLong()
}
</script>

<template>
	<div class="settings">
		<div class="setting">
			<div class="title">{{ i18n.t('settings.mc_version.label') }}</div>
			<select :aria-label="i18n.t('settings.mc_version.aria-label')" v-model="settingsStore.mc_version">
				<option v-for="version in Object.keys(versionMetadata)" :key="version" :value="version">
					{{ i18n.t(`settings.mc_version.mc${version}`) }}
				</option>
			</select>
		</div>

		<div class="setting">
			<div class="title">{{ i18n.t('settings.world_preset.label') }}</div>
			<select :aria-label="i18n.t('settings.world_preset.aria-label')" v-model="settingsStore.world_preset">
				<option v-for="world_preset in world_presets" :key="world_preset.toString()" :value="world_preset">
					{{ settingsStore.getLocalizedName('generator', world_preset, false) }}
				</option>
			</select>
		</div>

		<div class="setting">
			<div class="title">{{ i18n.t('settings.dimension.label') }}</div>
			<select :aria-label="i18n.t('settings.dimension.aria-label')" v-model="settingsStore.dimension">
				<option v-for="dimension in dimensions" :key="dimension.toString()" :value="dimension">
					{{ settingsStore.getLocalizedName('dimension', dimension, false) }}
				</option>
			</select>
		</div>

		<div class="setting view_setting">
			<div class="title">Map View:</div>
			<div class="map_view_toggle" role="tablist" aria-label="Map view">
				<button
					type="button"
					:class="{ active: settingsStore.map_view === 'biome' }"
					@click="settingsStore.map_view = 'biome'"
				>
					Biome
				</button>
				<button
					type="button"
					:class="{ active: settingsStore.map_view === 'terrain' }"
					@click="settingsStore.map_view = 'terrain'"
				>
					Terrain
				</button>
			</div>
		</div>

		<div class="setting">
			<div class="title short">{{ i18n.t('settings.seed.label') }}</div>
			<font-awesome-icon
				icon="fa-dice"
				class="button"
				tabindex="0"
				@click="randomizeSeed"
				@keypress.enter="randomizeSeed"
				:title="i18n.t('settings.seed.randomize_button.title')"
			/>
			<input
				:aria-label="i18n.t('settings.seed.aria-label')"
				:value="settingsStore.seed"
				@change="event => { settingsStore.seed = parseSeed((event.target as HTMLInputElement).value) }"
				type="text"
			/>
		</div>
	</div>
</template>

<style scoped>
.settings {
	width: 100%;
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	box-sizing: border-box;
}

.setting {
	width: 100%;
	max-width: 100%;
	box-sizing: border-box;
	display: flex;
	gap: 0.5rem;
	align-items: center;
	height: 2rem;
}

.view_setting {
	height: auto;
	align-items: flex-start;
}

.title {
	height: fit-content;
	width: 6.3rem;
}

.title.short {
	width: 3.8rem;
}

.button {
	background-color: lightgray;
	color: black;
	padding: 0.2rem;
	height: 1.6rem;
	width: 1.6rem;
	border-radius: 0.2rem;
}

.button:hover,
.button:active {
	background-color: white;
}

select,
input {
	box-sizing: border-box;
	height: 2rem;
	background-color: lightgray;
	width: 0;
	flex-grow: 1;
	color: black;
	border-radius: 0.3rem;
	border: 2px solid rgb(55, 120, 173);
}

.map_view_toggle {
	box-sizing: border-box;
	width: 0;
	flex-grow: 1;
	display: flex;
	gap: 0.35rem;
	background-color: rgba(0, 0, 0, 0.12);
	border: 2px solid rgb(55, 120, 173);
	border-radius: 0.45rem;
	padding: 0.2rem;
}

.map_view_toggle button {
	flex: 1;
	height: 2rem;
	border: none;
	border-radius: 0.32rem;
	background-color: transparent;
	color: white;
	cursor: pointer;
	font: inherit;
	transition: background-color 120ms ease, color 120ms ease;
}

.map_view_toggle button:hover {
	background-color: rgba(255, 255, 255, 0.1);
}

.map_view_toggle button.active {
	background-color: rgb(193, 224, 17);
	color: black;
	font-weight: 600;
}

.map_view_toggle button:focus-visible {
	outline: 2px solid yellow;
	outline-offset: 1px;
}
</style>
