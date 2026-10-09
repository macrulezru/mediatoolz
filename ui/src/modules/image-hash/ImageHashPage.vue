<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiError, api, watchJob, type ModuleInfo, type StatusInfo } from '../../api'
import { MasonryGrid, type MasonryGridItem } from '@macrulez/masonry-kit-vue'
import SourcePicker from '../../components/SourcePicker.vue'
import Icon from '../../components/Icon.vue'
import type { ResultEntry } from './placeholders'
import ResultCard from './ResultCard.vue'
import ResultModal from './ResultModal.vue'

defineProps<{ module: ModuleInfo; status: StatusInfo | undefined }>()

interface TypeOption {
  id: string
  title: string
  description: string
}

interface Options {
  types: TypeOption[]
  formats: string[]
  budget: { min: number; max: number; default: number }
  components: { default: string; auto: boolean }
  exportName: string
  sharp: boolean
}

interface RunResult {
  base: string
  filesScanned: number
  cached: number
  errors: { file: string; message: string }[]
  entries: ResultEntry[]
  output: string | null
  format: string
  exitCode: number
}

interface Progress {
  done: number
  total: number
  cached: number
}

const PAGE = 48
const MASONRY_OPTIONS = { columns: 'auto', minLaneSize: 250, gap: 14 } as const
const COMPONENT_CHOICES = ['auto', '3x3', '4x3', '4x4', '5x4', '6x4', '8x6']
const EXTENSIONS: Record<string, string> = {
  json: 'json',
  plain: 'txt',
  csv: 'csv',
  ts: 'ts',
  js: 'js',
}

const options = ref<Options>()
const sources = ref<string[]>([])
const recursive = ref(true)
const types = ref<string[]>(['hazehash', 'color'])
const budget = ref(28)
const components = ref('auto')
const format = ref('json')
const exportName = ref('imageHashes')

const viewing = ref<number | null>(null)
const phase = ref<'idle' | 'running' | 'done' | 'failed'>('idle')
const progress = ref<Progress>({ done: 0, total: 0, cached: 0 })
const failure = ref('')
const result = ref<RunResult>()
const tab = ref<'gallery' | 'output'>('gallery')
const shown = ref(PAGE)
const savePath = ref('')
const saveNote = ref('')
const copiedOutput = ref(false)
let stopWatching: (() => void) | undefined

const needsSharp = computed(() => failure.value.toLowerCase().includes('sharp'))
const canRun = computed(
  () => sources.value.length > 0 && types.value.length > 0 && phase.value !== 'running',
)
const percent = computed(() =>
  progress.value.total > 0 ? Math.round((progress.value.done / progress.value.total) * 100) : 0,
)
const visible = computed(() => result.value?.entries.slice(0, shown.value) ?? [])
const masonryItems = computed<MasonryGridItem[]>(() =>
  visible.value.map((entry, position) => ({ id: entry.path, position })),
)

function entryOf(item: MasonryGridItem): ResultEntry {
  return visible.value[Number(item.position)] as ResultEntry
}

function toggleType(id: string): void {
  types.value = types.value.includes(id)
    ? types.value.filter((type) => type !== id)
    : [...types.value, id]
}

function defaultSavePath(base: string, kind: string): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return `${base}${base.endsWith(sep) ? '' : sep}image-hashes.${EXTENSIONS[kind] ?? 'txt'}`
}

async function run(installSharp = false): Promise<void> {
  stopWatching?.()
  phase.value = 'running'
  failure.value = ''
  result.value = undefined
  saveNote.value = ''
  progress.value = { done: 0, total: 0, cached: 0 }
  shown.value = PAGE
  viewing.value = null
  try {
    const { jobId } = await api.post<{ jobId: string }>('/api/image-hash/run', {
      paths: sources.value,
      recursive: recursive.value,
      types: types.value,
      components: components.value,
      budget: budget.value,
      format: format.value,
      exportName: exportName.value,
      installSharp,
    })
    stopWatching = watchJob<Progress, RunResult>(jobId, {
      onProgress: (data) => {
        progress.value = data
      },
      onDone: (data) => {
        result.value = data
        phase.value = 'done'
        tab.value = 'gallery'
        savePath.value = defaultSavePath(data.base, data.format)
      },
      onFailed: (message) => {
        failure.value = message
        phase.value = 'failed'
      },
    })
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
    phase.value = 'failed'
  }
}

async function copyOutput(): Promise<void> {
  if (!result.value?.output) return
  try {
    await navigator.clipboard.writeText(result.value.output)
    copiedOutput.value = true
    setTimeout(() => (copiedOutput.value = false), 1200)
  } catch {
    copiedOutput.value = false
  }
}

function download(): void {
  const output = result.value?.output
  if (!output) return
  const blob = new Blob([output], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `image-hashes.${EXTENSIONS[result.value?.format ?? 'json'] ?? 'txt'}`
  link.click()
  URL.revokeObjectURL(link.href)
}

async function save(overwrite = false): Promise<void> {
  if (!result.value?.output) return
  saveNote.value = ''
  try {
    const saved = await api.post<{ path: string }>('/api/image-hash/save', {
      path: savePath.value,
      content: result.value.output,
      overwrite,
    })
    saveNote.value = `Saved to ${saved.path}`
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      if (window.confirm(`${error.message}. Replace it?`)) await save(true)
      return
    }
    saveNote.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(async () => {
  try {
    options.value = await api.get<Options>('/api/image-hash/options')
    budget.value = options.value.budget.default
    components.value = options.value.components.auto ? 'auto' : options.value.components.default
    exportName.value = options.value.exportName
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
    phase.value = 'failed'
  }
})

onBeforeUnmount(() => {
  stopWatching?.()
})
</script>

<template>
  <div class="page">
    <header class="page__head">
      <h1>{{ module.title }}</h1>
      <p class="muted">{{ module.description }}</p>
    </header>

    <div v-if="options && !options.sharp" class="notice notice--warn">
      The sharp image library is not installed yet. Previews are limited, and the first run will
      offer to install it.
    </div>

    <SourcePicker
      v-model:sources="sources"
      v-model:recursive="recursive"
      scan-url="/api/image-hash/scan"
      :start="status?.cwd ?? ''"
    />

    <section class="card block">
      <h2>Placeholders</h2>
      <div class="types">
        <label
          v-for="type in options?.types"
          :key="type.id"
          class="type"
          :class="{ 'type--on': types.includes(type.id) }"
        >
          <input type="checkbox" :checked="types.includes(type.id)" @change="toggleType(type.id)" />
          <span class="type__title">{{ type.title }}</span>
          <span class="type__text muted">{{ type.description }}</span>
        </label>
      </div>

      <div class="grid">
        <label v-if="types.includes('hazehash')" class="field">
          <span>Hazehash size: {{ budget }} bytes</span>
          <input
            v-model.number="budget"
            type="range"
            :min="options?.budget.min"
            :max="options?.budget.max"
          />
        </label>
        <label v-if="types.includes('blurhash')" class="field">
          <span>Blurhash components</span>
          <select v-model="components" class="select">
            <option v-for="choice in COMPONENT_CHOICES" :key="choice" :value="choice">
              {{ choice === 'auto' ? 'auto (by aspect ratio)' : choice }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>Output format</span>
          <select v-model="format" class="select">
            <option v-for="choice in options?.formats" :key="choice" :value="choice">
              {{ choice }}
            </option>
          </select>
        </label>
        <label v-if="format === 'ts' || format === 'js'" class="field">
          <span>Export name</span>
          <input v-model="exportName" class="input" spellcheck="false" />
        </label>
      </div>
    </section>

    <div class="runbar">
      <button class="btn btn--primary" :disabled="!canRun" @click="run(false)">
        <Icon name="play" :size="15" /> {{ phase === 'running' ? 'Working…' : 'Compute hashes' }}
      </button>
      <span v-if="sources.length === 0" class="muted">Add at least one folder or image.</span>
      <span v-else-if="types.length === 0" class="muted">Pick at least one placeholder.</span>
    </div>

    <div v-if="phase === 'running'" class="card block" role="status">
      <div class="progress"><div class="progress__bar" :style="{ width: `${percent}%` }" /></div>
      <span class="muted">
        {{ progress.done }} of {{ progress.total || '…' }} images<span v-if="progress.cached">
          · {{ progress.cached }} from cache</span
        >
      </span>
    </div>

    <div v-if="phase === 'failed'" class="notice notice--error">
      <p>{{ failure }}</p>
      <button v-if="needsSharp" class="btn btn--small" @click="run(true)">
        Install sharp and retry
      </button>
    </div>

    <section v-if="result" class="card block">
      <div class="block__head">
        <h2>Result</h2>
        <span class="muted">
          {{ result.entries.length }} image{{ result.entries.length === 1 ? '' : 's' }}
          <span v-if="result.cached">· {{ result.cached }} cached</span>
          <span v-if="result.errors.length">· {{ result.errors.length }} failed</span>
        </span>
      </div>

      <ul v-if="result.errors.length" class="errors">
        <li v-for="error in result.errors" :key="error.file">
          <code>{{ error.file }}</code> — {{ error.message }}
        </li>
      </ul>

      <div class="tabs" role="tablist">
        <button
          class="tab"
          :class="{ 'tab--on': tab === 'gallery' }"
          role="tab"
          :aria-selected="tab === 'gallery'"
          @click="tab = 'gallery'"
        >
          Gallery
        </button>
        <button
          class="tab"
          :class="{ 'tab--on': tab === 'output' }"
          role="tab"
          :aria-selected="tab === 'output'"
          @click="tab = 'output'"
        >
          Output ({{ result.format }})
        </button>
      </div>

      <template v-if="tab === 'gallery'">
        <p v-if="result.entries.length === 0" class="muted">No images were found.</p>
        <MasonryGrid class="gallery" :items="masonryItems" :options="MASONRY_OPTIONS">
          <template #item="{ item }">
            <ResultCard :entry="entryOf(item)" @open="viewing = Number(item.position)" />
          </template>
        </MasonryGrid>
        <div v-if="shown < result.entries.length" class="more">
          <button class="btn" @click="shown += PAGE">
            Show more ({{ result.entries.length - shown }} left)
          </button>
          <button class="btn" @click="shown = result.entries.length">
            Show all ({{ result.entries.length }})
          </button>
        </div>
      </template>

      <template v-else>
        <div class="outbar">
          <button class="btn btn--small" @click="copyOutput">
            <Icon :name="copiedOutput ? 'check' : 'copy'" :size="15" />
            {{ copiedOutput ? 'Copied' : 'Copy' }}
          </button>
          <button class="btn btn--small" @click="download">
            <Icon name="download" :size="15" /> Download
          </button>
          <input
            v-model="savePath"
            class="input outbar__path"
            spellcheck="false"
            aria-label="File to write"
          />
          <button class="btn btn--small" :disabled="savePath.trim() === ''" @click="save(false)">
            <Icon name="save" :size="15" /> Write to file
          </button>
        </div>
        <p v-if="saveNote" class="muted">{{ saveNote }}</p>
        <pre class="output">{{ result.output }}</pre>
      </template>
    </section>

    <ResultModal
      v-if="result && viewing !== null"
      v-model:index="viewing"
      :entries="result.entries"
      @close="viewing = null"
    />
  </div>
</template>

<style scoped lang="scss">
.page {
  @include stack($space-4);
  padding: 28px 28px 60px;

  @include respond-below(md) {
    padding: 18px 14px 40px;
  }

  &__head p {
    margin-top: $space-1;
  }
}

.block {
  @include stack(14px);
  padding: 18px;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: $space-3;
  }
}

.types {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}

.type {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 10px;
  row-gap: 2px;
  padding: $space-3;
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;

  &--on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  input {
    grid-row: 1 / 3;
    margin-top: 3px;
  }

  &__title {
    font-weight: 600;
  }

  &__text {
    font-size: $font-size-sm;
  }
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.runbar {
  display: flex;
  align-items: center;
  gap: 14px;
}

.progress {
  height: $space-2;
  overflow: hidden;
  border-radius: $radius-pill;
  background: var(--surface-2);

  &__bar {
    height: 100%;
    background: var(--accent);
    transition: width $transition-fast;
  }
}

.errors {
  margin: 0;
  padding: 10px 14px 10px 28px;
  border-radius: 10px;
  background: var(--danger-soft);
  color: var(--danger);
}

.tabs {
  display: flex;
  gap: $space-1;
  border-bottom: 1px solid var(--border);
}

.tab {
  padding: $space-2 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  @include focus-ring;

  &--on {
    border-bottom-color: var(--accent);
    color: var(--text);
    font-weight: 600;
  }
}

.gallery {
  width: 100%;
}

.more {
  @include cluster;
  justify-content: center;
}

.outbar {
  @include cluster;

  &__path {
    flex: 1;
    min-width: 220px;
    height: $control-height-sm;
    font-family: $font-mono;
    font-size: $font-size-sm;
  }
}

.output {
  max-height: 420px;
  margin: 0;
  padding: 14px;
  border-radius: 10px;
  background: var(--surface-2);
  font-size: $font-size-sm;
  white-space: pre-wrap;
  word-break: break-all;
  overflow: auto;
}
</style>
