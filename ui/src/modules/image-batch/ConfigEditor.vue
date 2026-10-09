<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, api } from '../../api'
import Icon from '../../components/Icon.vue'
import { EMPTY_PROJECT, PROJECT } from './nav'
import UiSegmented from '../../ui-components/UiSegmented.vue'
import RecipeForm from './RecipeForm.vue'
import { starterConfig, starterRecipe, type Raw } from './recipe'
import type { BatchOptions } from './types'

const props = defineProps<{
  options: BatchOptions
  initial?: { name: string; scope: 'project' | 'global' } | undefined
  copyOf?: { name: string; raw: Raw } | undefined
}>()
const emit = defineEmits<{ saved: [name: string]; cancel: [] }>()
const project = inject(PROJECT, EMPTY_PROJECT)

interface Check {
  ok: boolean
  error?: string
  lines?: string[]
}

const loading = ref(props.initial !== undefined)
const raw = ref<Raw>(props.copyOf ? structuredClone(props.copyOf.raw) : starterConfig())
const name = ref(
  props.initial ? props.initial.name : props.copyOf ? `${props.copyOf.name}-copy` : '',
)
const scope = ref<'project' | 'global'>(props.initial?.scope ?? 'project')
const tab = ref<'form' | 'json'>('form')
const jsonText = ref('')
const jsonError = ref('')
const check = ref<Check>()
const failure = ref('')
const saving = ref(false)
const openRecipe = ref(0)
let timer: ReturnType<typeof setTimeout> | undefined

const outputs = computed<Raw[]>(() =>
  Array.isArray(raw.value.outputs) ? (raw.value.outputs as Raw[]) : [],
)
const defaults = computed<Raw>(() =>
  raw.value.defaults && typeof raw.value.defaults === 'object' ? (raw.value.defaults as Raw) : {},
)
const presetNames = computed(() =>
  raw.value.presets && typeof raw.value.presets === 'object'
    ? Object.keys(raw.value.presets as Raw)
    : [],
)
const extras = computed(() => {
  const found: string[] = []
  if (presetNames.value.length) found.push(`${presetNames.value.length} preset(s)`)
  if (Array.isArray(raw.value.match) && raw.value.match.length)
    found.push(`${raw.value.match.length} rule(s)`)
  if (raw.value.placeholders) found.push('placeholders')
  return found
})
const checkText = computed(() => (check.value?.lines ?? []).join('\n'))
const canSave = computed(
  () =>
    !saving.value && name.value.trim() !== '' && check.value?.ok === true && jsonError.value === '',
)

function setRaw(next: Raw): void {
  raw.value = next
}

function setTitle(key: 'name' | 'description', value: string): void {
  const next = { ...raw.value }
  if (value.trim() === '') delete next[key]
  else next[key] = value
  setRaw(next)
}

function setDefaults(value: Raw): void {
  const next = { ...raw.value }
  if (Object.keys(value).length === 0) delete next.defaults
  else next.defaults = value
  setRaw(next)
}

function setOutput(index: number, value: Raw): void {
  const list = [...outputs.value]
  list[index] = value
  setRaw({ ...raw.value, outputs: list })
}

function addRecipe(): void {
  setRaw({ ...raw.value, outputs: [...outputs.value, starterRecipe(outputs.value.length + 1)] })
  openRecipe.value = outputs.value.length
}

function removeRecipe(index: number): void {
  setRaw({ ...raw.value, outputs: outputs.value.filter((_, at) => at !== index) })
  openRecipe.value = Math.max(0, openRecipe.value - 1)
}

function duplicateRecipe(index: number): void {
  const copy = structuredClone(outputs.value[index] ?? {}) as Raw
  if (typeof copy.id === 'string') copy.id = `${copy.id}-copy`
  const list = [...outputs.value]
  list.splice(index + 1, 0, copy)
  setRaw({ ...raw.value, outputs: list })
  openRecipe.value = index + 1
}

function moveRecipe(index: number, step: number): void {
  const target = index + step
  if (target < 0 || target >= outputs.value.length) return
  const list = [...outputs.value]
  const [item] = list.splice(index, 1)
  list.splice(target, 0, item as Raw)
  setRaw({ ...raw.value, outputs: list })
  openRecipe.value = target
}

function recipeTitle(recipe: Raw, index: number): string {
  return typeof recipe.id === 'string' && recipe.id ? recipe.id : `Recipe ${index + 1}`
}

function recipeSummary(recipe: Raw): string {
  const parts: string[] = []
  for (const key of ['widths', 'heights', 'longEdge', 'shortEdge', 'megapixels', 'percent']) {
    if (Array.isArray(recipe[key])) parts.push(`${key} ${(recipe[key] as unknown[]).join(', ')}`)
  }
  if (typeof recipe.size === 'string') parts.push(`box ${recipe.size}`)
  if (Array.isArray(recipe.formats)) parts.push((recipe.formats as string[]).join('/'))
  return parts.join(' · ')
}

function onJson(text: string): void {
  jsonText.value = text
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      jsonError.value = 'A config is a JSON object.'
      return
    }
    jsonError.value = ''
    raw.value = parsed as Raw
  } catch (error) {
    jsonError.value = error instanceof Error ? error.message : String(error)
  }
}

function switchTab(next: 'form' | 'json'): void {
  if (next === 'json') {
    jsonText.value = JSON.stringify(raw.value, null, 2)
    jsonError.value = ''
    tab.value = 'json'
    return
  }
  if (jsonError.value) return
  tab.value = 'form'
}

async function validate(): Promise<void> {
  try {
    check.value = await api.post<Check>('/api/image-batch/config/validate', { raw: raw.value })
  } catch (error) {
    check.value = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

watch(
  raw,
  () => {
    clearTimeout(timer)
    timer = setTimeout(() => void validate(), 350)
  },
  { deep: true },
)

async function save(overwrite = false): Promise<void> {
  saving.value = true
  failure.value = ''
  try {
    await api.post('/api/image-batch/config/save', {
      name: name.value,
      scope: scope.value,
      raw: raw.value,
      overwrite,
      ...(props.initial
        ? { originalName: props.initial.name, originalScope: props.initial.scope }
        : {}),
    })
    emit('saved', name.value)
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.body.exists === true) {
      if (window.confirm(`${error.message}. Replace it?`)) {
        await save(true)
        return
      }
    } else {
      failure.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  if (props.initial) {
    try {
      const loaded = await api.get<{ raw: Raw }>(
        `/api/image-batch/config?name=${encodeURIComponent(props.initial.name)}&scope=${props.initial.scope}`,
      )
      raw.value = loaded.raw
    } catch (error) {
      failure.value = error instanceof Error ? error.message : String(error)
    } finally {
      loading.value = false
    }
  }
  void validate()
})

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <section class="card block">
    <div class="head">
      <h2>{{ initial ? `Edit ${initial.name}` : copyOf ? 'Copy of a config' : 'New config' }}</h2>
      <button class="btn btn--ghost" @click="emit('cancel')">
        <Icon name="close" :size="16" /> Close
      </button>
    </div>

    <p v-if="loading" class="muted">Loading…</p>
    <template v-else>
      <div class="grid">
        <label class="field">
          <span>File name</span>
          <input v-model="name" class="input" spellcheck="false" placeholder="web" />
        </label>
        <label class="field">
          <span>Where to keep it</span>
          <select v-model="scope" class="select">
            <option value="project">This project ({{ project.name }})</option>
            <option value="global">All projects (your home folder)</option>
          </select>
        </label>
        <label class="field">
          <span>Title</span>
          <input
            class="input"
            :value="String(raw.name ?? '')"
            @input="setTitle('name', ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field">
          <span>Description</span>
          <input
            class="input"
            :value="String(raw.description ?? '')"
            @input="setTitle('description', ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>

      <UiSegmented
        :model-value="tab"
        label="Editor mode"
        :options="[
          { value: 'form', label: 'Form' },
          { value: 'json', label: 'JSON' },
        ]"
        @update:model-value="switchTab"
      />

      <template v-if="tab === 'form'">
        <p v-if="extras.length" class="notice">
          This config also has {{ extras.join(', ') }}. They are kept as they are; edit them in the
          JSON tab.
        </p>

        <details class="panel">
          <summary>Defaults for every recipe</summary>
          <div class="panel__body">
            <RecipeForm
              :model-value="defaults"
              :options="options"
              :preset-names="presetNames"
              is-defaults
              @update:model-value="setDefaults"
            />
          </div>
        </details>

        <div class="recipes">
          <div
            v-for="(recipe, index) in outputs"
            :key="index"
            class="panel"
            :class="{ 'panel--open': openRecipe === index }"
          >
            <div class="panel__head">
              <button class="panel__title" @click="openRecipe = openRecipe === index ? -1 : index">
                <strong>{{ recipeTitle(recipe, index) }}</strong>
                <span class="muted small">{{ recipeSummary(recipe) }}</span>
              </button>
              <div class="panel__actions">
                <button
                  class="btn btn--ghost btn--small"
                  :disabled="index === 0"
                  aria-label="Move up"
                  @click="moveRecipe(index, -1)"
                >
                  <Icon name="up" :size="14" />
                </button>
                <button
                  class="btn btn--ghost btn--small"
                  :disabled="index === outputs.length - 1"
                  aria-label="Move down"
                  @click="moveRecipe(index, 1)"
                >
                  <Icon name="down" :size="14" />
                </button>
                <button
                  class="btn btn--ghost btn--small"
                  aria-label="Duplicate recipe"
                  @click="duplicateRecipe(index)"
                >
                  <Icon name="copy" :size="14" />
                </button>
                <button
                  class="btn btn--ghost btn--small btn--danger"
                  aria-label="Remove recipe"
                  @click="removeRecipe(index)"
                >
                  <Icon name="close" :size="14" />
                </button>
              </div>
            </div>
            <div v-if="openRecipe === index" class="panel__body">
              <RecipeForm
                :model-value="recipe"
                :options="options"
                :preset-names="presetNames"
                @update:model-value="setOutput(index, $event)"
              />
            </div>
          </div>
        </div>
        <button class="btn" @click="addRecipe"><Icon name="plus" :size="16" /> Add a recipe</button>
      </template>

      <template v-else>
        <textarea
          class="json"
          spellcheck="false"
          :value="jsonText"
          aria-label="Config JSON"
          @input="onJson(($event.target as HTMLTextAreaElement).value)"
        />
        <p v-if="jsonError" class="notice notice--error">{{ jsonError }}</p>
      </template>

      <div
        v-if="check"
        class="check-panel"
        :class="check.ok ? 'check-panel--ok' : 'check-panel--bad'"
        role="status"
      >
        <template v-if="check.ok">
          <strong>The config is valid.</strong>
          <pre v-if="check.lines?.length" class="lines">{{ checkText }}</pre>
        </template>
        <template v-else>{{ check.error }}</template>
      </div>

      <p v-if="failure" class="notice notice--error">{{ failure }}</p>
      <div class="actions">
        <button class="btn btn--primary" :disabled="!canSave" @click="save(false)">
          <Icon name="save" :size="15" /> Save config
        </button>
        <button class="btn" @click="emit('cancel')">Cancel</button>
      </div>
    </template>
  </section>
</template>

<style scoped lang="scss">
.block {
  @include stack($space-4);
  padding: 18px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.small {
  font-size: $font-size-sm;
}

.recipes {
  @include stack($space-2);
}

.panel {
  border: 1px solid var(--border);
  border-radius: $radius-md;

  &--open {
    border-color: var(--accent);
  }

  &__head {
    display: flex;
    align-items: center;
    gap: $space-2;
    padding: $space-1 $space-2 $space-1 $space-3;
  }

  &__title {
    @include stack(0);
    flex: 1;
    min-width: 0;
    padding: $space-2 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
    @include focus-ring;

    .small {
      @include truncate;
    }
  }

  &__actions {
    @include cluster(2px);
    flex: none;
  }

  &__body {
    padding: $space-3 $space-4 $space-4;
    border-top: 1px solid var(--border);
  }

  summary {
    padding: $space-3;
    cursor: pointer;
    font-weight: 600;
  }
}

details.panel > .panel__body {
  border-top: 1px solid var(--border);
}

.json {
  min-height: 420px;
  padding: $space-3;
  border: 1px solid var(--border);
  border-radius: $radius-md;
  background: var(--surface-2);
  font-family: $font-mono;
  font-size: $font-size-sm;
  resize: vertical;
  tab-size: 2;
  @include focus-ring;
}

.check-panel {
  padding: 10px 14px;
  border-radius: $radius-md;

  &--ok {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
  }

  &--bad {
    background: var(--danger-soft);
    color: var(--danger);
  }
}

.lines {
  margin: $space-2 0 0;
  font-size: $font-size-sm;
  white-space: pre-wrap;
}

.actions {
  @include cluster;
}
</style>
