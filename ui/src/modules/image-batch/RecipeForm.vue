<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SharpenSettings from './SharpenSettings.vue'
import {
  parseNumbers,
  setSizeMethod,
  sharpenToState,
  sizeMethodOf,
  stateToSharpen,
  valuesText,
  withKey,
  type Raw,
} from './recipe'
import type { BatchOptions, SharpenState, SizeMethod } from './types'

const props = defineProps<{
  modelValue: Raw
  options: BatchOptions
  presetNames?: string[]
  isDefaults?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: Raw] }>()

const METHOD_LABELS: Record<SizeMethod, string> = {
  original: 'Keep the original size',
  widths: 'By width (px)',
  heights: 'By height (px)',
  size: 'Fit into a box',
  longEdge: 'By the long side (px)',
  shortEdge: 'By the short side (px)',
  megapixels: 'By area (megapixels)',
  percent: 'By percentage',
}

const ADVANCED_SELECTS: { key: string; label: string; options: string[] }[] = [
  { key: 'metadata', label: 'Metadata', options: ['strip', 'keep', 'keep-icc'] },
  { key: 'rotate', label: 'Rotate (degrees)', options: ['90', '180', '270'] },
]
const ADVANCED_FLAGS: { key: string; label: string }[] = [
  { key: 'withoutEnlargement', label: 'Never enlarge' },
  { key: 'autoOrient', label: 'Turn by EXIF orientation' },
  { key: 'grayscale', label: 'Grayscale' },
  { key: 'flip', label: 'Flip vertically' },
  { key: 'flop', label: 'Mirror horizontally' },
]

const draft = ref('')
const draftError = ref(false)
const advancedOpen = ref(false)
const sharpenLossy = ref(false)
const sharpenState = ref<SharpenState>(sharpenToState(props.modelValue.sharpen).state)

const method = computed(() => sizeMethodOf(props.modelValue))
const formatsList = computed(() =>
  Array.isArray(props.modelValue.formats) ? (props.modelValue.formats as string[]) : undefined,
)
const formatsComplex = computed(
  () => props.modelValue.formats !== undefined && formatsList.value === undefined,
)
const qualityValue = computed(() => props.modelValue.quality)
const qualityComplex = computed(
  () => qualityValue.value !== undefined && typeof qualityValue.value === 'object',
)
const qualityChoice = computed(() => {
  const value = qualityValue.value
  if (value === undefined) return ''
  if (typeof value === 'number') return 'custom'
  return String(value)
})
const template = computed(() =>
  typeof props.modelValue.name === 'string' ? props.modelValue.name : '',
)
const maxBytesText = computed(() =>
  props.modelValue.maxBytes === undefined ? '' : String(props.modelValue.maxBytes),
)
const sharpenMissing = computed(() => {
  const value = props.modelValue.sharpen
  return value !== undefined && typeof value !== 'string' && typeof value !== 'object'
})

function update(key: string, value: unknown): void {
  emit('update:modelValue', withKey(props.modelValue, key, value))
}

function syncDraft(): void {
  draft.value = valuesText(props.modelValue, method.value)
  draftError.value = false
}

watch(method, syncDraft, { immediate: true })

watch(
  () => props.modelValue.sharpen,
  (value) => {
    const next = sharpenToState(value)
    sharpenLossy.value = next.lossy
    if (JSON.stringify(stateToSharpen(sharpenState.value)) !== JSON.stringify(value)) {
      sharpenState.value = next.state
    }
  },
  { immediate: true },
)

function changeMethod(event: Event): void {
  emit(
    'update:modelValue',
    setSizeMethod(props.modelValue, (event.target as HTMLSelectElement).value as SizeMethod),
  )
}

function changeValues(text: string): void {
  draft.value = text
  const numbers = parseNumbers(text)
  draftError.value = numbers === undefined
  if (numbers && numbers.length > 0 && method.value !== 'original' && method.value !== 'size') {
    update(method.value, numbers)
  }
}

function toggleFormat(format: string): void {
  const current = formatsList.value ?? []
  update(
    'formats',
    current.includes(format) ? current.filter((item) => item !== format) : [...current, format],
  )
}

function changeQuality(choice: string): void {
  if (choice === '') update('quality', undefined)
  else if (choice === 'custom') update('quality', 82)
  else update('quality', choice)
}

function changeMaxBytes(text: string): void {
  const trimmed = text.trim()
  if (trimmed === '') update('maxBytes', undefined)
  else update('maxBytes', /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed)
}

function changeSharpen(state: SharpenState): void {
  sharpenState.value = state
  update('sharpen', stateToSharpen(state))
}

function triState(key: string): string {
  const value = props.modelValue[key]
  return value === undefined ? '' : String(value)
}

function setTriState(key: string, text: string): void {
  update(key, text === '' ? undefined : text === 'true')
}

function insertToken(token: string): void {
  update('name', (template.value || '{dir}/{name}') + '{' + token + '}')
}

function tokenLabel(token: string): string {
  return '{' + token + '}'
}
</script>

<template>
  <div class="recipe">
    <div v-if="!isDefaults" class="grid">
      <label class="field">
        <span>Recipe name</span>
        <input
          class="input"
          spellcheck="false"
          :value="String(modelValue.id ?? '')"
          @input="update('id', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label v-if="presetNames && presetNames.length" class="field">
        <span>Based on preset</span>
        <select
          class="select"
          :value="String(modelValue.preset ?? '')"
          @change="update('preset', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">None</option>
          <option v-for="item in presetNames" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
    </div>

    <div class="group">
      <h4>Size</h4>
      <div class="grid">
        <label class="field">
          <span>Method</span>
          <select class="select" :value="method" @change="changeMethod">
            <option v-for="item in options.sizeMethods" :key="item" :value="item">
              {{ METHOD_LABELS[item] }}
            </option>
          </select>
        </label>
        <label v-if="method === 'size'" class="field">
          <span>Box (width × height)</span>
          <input
            class="input"
            spellcheck="false"
            :value="String(modelValue.size ?? '')"
            @input="update('size', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label v-else-if="method !== 'original'" class="field">
          <span>Values (comma-separated)</span>
          <input
            class="input"
            :class="{ 'input--bad': draftError }"
            spellcheck="false"
            :value="draft"
            @input="changeValues(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label v-if="method === 'size'" class="field">
          <span>How it fills the box</span>
          <select
            class="select"
            :value="String(modelValue.fit ?? 'inside')"
            @change="update('fit', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="item in options.fitModes" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
      </div>
      <label v-if="method === 'size'" class="check">
        <input
          type="checkbox"
          :checked="modelValue.matchOrientation === true"
          @change="
            update('matchOrientation', ($event.target as HTMLInputElement).checked || undefined)
          "
        />
        Turn the box around for portrait images
      </label>
    </div>

    <div class="group">
      <h4>Formats and quality</h4>
      <p v-if="formatsComplex" class="notice notice--warn">
        The formats of this recipe are set in a form the editor cannot show. Use the JSON tab.
      </p>
      <div v-else class="pills">
        <label
          v-for="format in options.formats"
          :key="format"
          class="pill"
          :class="{ 'pill--on': formatsList?.includes(format) }"
        >
          <input
            type="checkbox"
            :checked="formatsList?.includes(format)"
            @change="toggleFormat(format)"
          />
          {{ format }}
        </label>
        <span v-if="!formatsList" class="muted small"
          >none chosen — inherited from the defaults</span
        >
      </div>
      <div class="grid">
        <label v-if="!qualityComplex" class="field">
          <span>Quality</span>
          <select
            class="select"
            :value="qualityChoice"
            @change="changeQuality(($event.target as HTMLSelectElement).value)"
          >
            <option value="">Default (high)</option>
            <option v-for="level in options.qualityLevels" :key="level" :value="level">
              {{ level }}
            </option>
            <option value="custom">A number…</option>
          </select>
        </label>
        <label v-if="qualityChoice === 'custom'" class="field">
          <span>Quality (1–100)</span>
          <input
            class="input"
            inputmode="numeric"
            :value="String(modelValue.quality)"
            @input="update('quality', Number(($event.target as HTMLInputElement).value))"
          />
        </label>
        <p v-if="qualityComplex" class="notice notice--warn">
          Quality is set per format here. Use the JSON tab to change it.
        </p>
        <label class="field">
          <span>Largest file size</span>
          <input
            class="input"
            spellcheck="false"
            placeholder="e.g. 200KB (optional)"
            :value="maxBytesText"
            @input="changeMaxBytes(($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </div>

    <div class="group">
      <h4>File names</h4>
      <input
        class="input"
        spellcheck="false"
        :value="template"
        :placeholder="options.defaultTemplates[method]"
        aria-label="File name template"
        @input="update('name', ($event.target as HTMLInputElement).value)"
      />
      <div class="pills">
        <button
          v-for="token in options.templateVariables"
          :key="token"
          class="pill pill--button"
          @click="insertToken(token)"
        >
          {{ tokenLabel(token) }}
        </button>
      </div>
    </div>

    <div class="group">
      <h4>Sharpening</h4>
      <p v-if="sharpenLossy || sharpenMissing" class="notice notice--warn">
        This sharpening combines a preset with extra values. Use the JSON tab to edit it.
      </p>
      <SharpenSettings
        v-else
        :model-value="sharpenState"
        :options="options"
        @update:model-value="changeSharpen"
      />
    </div>

    <div class="group">
      <button class="link" @click="advancedOpen = !advancedOpen">
        {{ advancedOpen ? 'Hide' : 'Show' }} advanced settings
      </button>
      <template v-if="advancedOpen">
        <div class="grid">
          <label v-for="item in ADVANCED_SELECTS" :key="item.key" class="field">
            <span>{{ item.label }}</span>
            <select
              class="select"
              :value="
                item.key === 'rotate'
                  ? String(modelValue.rotate ?? '')
                  : String(modelValue[item.key] ?? '')
              "
              @change="
                update(
                  item.key,
                  item.key === 'rotate' && ($event.target as HTMLSelectElement).value
                    ? Number(($event.target as HTMLSelectElement).value)
                    : ($event.target as HTMLSelectElement).value,
                )
              "
            >
              <option value="">Default</option>
              <option v-for="choice in item.options" :key="choice" :value="choice">
                {{ choice }}
              </option>
            </select>
          </label>
          <label v-for="item in ADVANCED_FLAGS" :key="item.key" class="field">
            <span>{{ item.label }}</span>
            <select
              class="select"
              :value="triState(item.key)"
              @change="setTriState(item.key, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Default</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
          <label class="field">
            <span>Blur (sigma)</span>
            <input
              class="input"
              inputmode="decimal"
              :value="modelValue.blur === undefined ? '' : String(modelValue.blur)"
              @input="
                update(
                  'blur',
                  ($event.target as HTMLInputElement).value === ''
                    ? undefined
                    : Number(($event.target as HTMLInputElement).value),
                )
              "
            />
          </label>
          <label class="field">
            <span>Background (#rrggbb)</span>
            <input
              class="input"
              spellcheck="false"
              :value="String(modelValue.background ?? '')"
              @input="update('background', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.recipe {
  @include stack($space-4);
}

.group {
  @include stack($space-3 - 2);

  h4 {
    @include eyebrow;
    margin: 0;
  }
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 14px;
}

.small {
  font-size: $font-size-sm;
}

.input--bad {
  border-color: var(--danger);
}

.pills {
  @include cluster;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: $radius-pill;
  background: var(--surface);
  font-size: $font-size-sm;
  cursor: pointer;

  input {
    display: none;
  }

  &--on {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }

  &--button {
    font-family: $font-mono;
    @include focus-ring;
  }
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
