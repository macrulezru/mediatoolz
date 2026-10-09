<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue'
import { api } from '../../api'
import UiSegmented from '../../ui-components/UiSegmented.vue'
import { NAVIGATE } from './nav'
import type { BatchOptions, SharpenPresetRow, SharpenState } from './types'

const props = defineProps<{ options: BatchOptions; manage?: boolean }>()
const navigate = inject(NAVIGATE, () => undefined)
const state = defineModel<SharpenState>({ required: true })

const presets = ref<SharpenPresetRow[]>([])
const fineOpen = ref(false)

const usable = computed(() => presets.value.filter((preset) => !preset.error))
const chosen = computed(() => presets.value.find((preset) => preset.name === state.value.preset))

function describe(preset: SharpenPresetRow): string {
  const fields = preset.fields ?? {}
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ')
}

function setMode(mode: SharpenState['mode']): void {
  state.value = { ...state.value, mode }
  if (mode === 'preset' && !state.value.preset && usable.value[0]) {
    state.value = { ...state.value, mode, preset: usable.value[0].name }
  }
}

function setFine(key: keyof SharpenState['fine'], value: string): void {
  state.value = { ...state.value, fine: { ...state.value.fine, [key]: value } }
}

function rangeText(key: string): string {
  const found = props.options.sharpen.fine.find((entry) => entry.key === key)
  return found ? `${found.range[0]}–${found.range[1]}` : ''
}

onMounted(async () => {
  try {
    presets.value = await api.get<SharpenPresetRow[]>('/api/image-batch/sharpen-presets')
  } catch {
    presets.value = []
  }
})
</script>

<template>
  <div class="sharpen">
    <UiSegmented
      :model-value="state.mode"
      label="Sharpening"
      :options="[
        { value: 'none', label: 'None' },
        { value: 'preset', label: 'Saved preset' },
        { value: 'custom', label: 'Custom' },
      ]"
      @update:model-value="setMode"
    />

    <div v-if="state.mode === 'preset'" class="grid">
      <label class="field">
        <span>Preset</span>
        <select
          class="select"
          :value="state.preset"
          @change="state = { ...state, preset: ($event.target as HTMLSelectElement).value }"
        >
          <option v-for="preset in usable" :key="preset.name" :value="preset.name">
            {{ preset.name }} · {{ preset.scope }}
          </option>
        </select>
      </label>
      <button v-if="manage" class="link" @click="navigate('sharpen')">Manage presets</button>
      <p v-if="chosen" class="hint muted">
        <template v-if="chosen.description">{{ chosen.description }} — </template>
        {{ describe(chosen) }}
      </p>
    </div>

    <template v-if="state.mode === 'custom'">
      <div class="grid">
        <label class="field">
          <span>Sharpen for</span>
          <select
            class="select"
            :value="state.for"
            @change="state = { ...state, for: ($event.target as HTMLSelectElement).value }"
          >
            <option v-for="target in options.sharpen.targets" :key="target" :value="target">
              {{ target }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>Amount</span>
          <select
            class="select"
            :value="state.amount"
            @change="state = { ...state, amount: ($event.target as HTMLSelectElement).value }"
          >
            <option v-for="amount in options.sharpen.amounts" :key="amount" :value="amount">
              {{ amount }}
            </option>
          </select>
        </label>
      </div>
      <button class="link" @click="fineOpen = !fineOpen">
        {{ fineOpen ? 'Hide' : 'Show' }} fine settings
      </button>
      <div v-if="fineOpen" class="grid">
        <label v-for="entry in options.sharpen.fine" :key="entry.key" class="field">
          <span
            >{{ entry.key }} <small class="muted">({{ rangeText(entry.key) }})</small></span
          >
          <input
            class="input"
            inputmode="decimal"
            placeholder="table value"
            :value="state.fine[entry.key as keyof SharpenState['fine']]"
            @input="
              setFine(
                entry.key as keyof SharpenState['fine'],
                ($event.target as HTMLInputElement).value,
              )
            "
          />
        </label>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.sharpen {
  @include stack($space-3);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: $space-3;
}

.hint {
  align-self: end;
  font-size: $font-size-sm;
}

.link {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  @include focus-ring;
}
</style>
