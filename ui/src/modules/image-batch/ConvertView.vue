<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, watchJob } from '../../api'
import FolderBrowser from '../../components/FolderBrowser.vue'
import Icon from '../../components/Icon.vue'
import SourcePicker, { type ScanResult } from '../../components/SourcePicker.vue'
import UiSegmented from '../../ui-components/UiSegmented.vue'
import BatchResults from './BatchResults.vue'
import { NAVIGATE } from './nav'
import SharpenSettings from './SharpenSettings.vue'
import {
  emptySharpen,
  sharpenPayload,
  type BatchOptions,
  type BatchReport,
  type ConfigRow,
  type OverwriteMode,
  type Placement,
  type SizeMethod,
} from './types'

const props = defineProps<{ cwd: string; options: BatchOptions }>()
const navigate = inject(NAVIGATE, () => undefined)

interface Progress {
  done: number
  total: number
}

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

const METHOD_HINTS: Record<SizeMethod, string> = {
  original: '',
  widths: 'e.g. 400, 800, 1200 — one file per size',
  heights: 'e.g. 300, 600',
  size: '',
  longEdge: 'e.g. 1600 — the same for landscape and portrait',
  shortEdge: 'e.g. 1080',
  megapixels: 'e.g. 2, 0.5',
  percent: 'e.g. 50, 25',
}

const SAMPLE_TOKENS: Record<string, string> = {
  name: 'photo',
  ext: 'jpg',
  orig: 'photo.jpg',
  dir: 'trips/2026',
  format: 'webp',
  width: '800',
  height: '600',
  size: '800x600',
  long: '800',
  short: '600',
  mp: '0.48',
  percent: '50',
  scale: '2',
  index: '001',
  hash: 'a1b2c3d4',
  date: '2026-10-08',
}

const options = computed(() => props.options)
const configs = ref<ConfigRow[]>([])
const sources = ref<string[]>([])
const recursive = ref(true)
const scanTotal = ref(0)

const placement = ref<Placement>('out')
const outDir = ref('')
const flat = ref(false)
const overwrite = ref<OverwriteMode>('skip')
const backup = ref(true)
const onlyIfSmaller = ref(true)
const browsingOut = ref(false)

const mode = ref<'quick' | 'config'>('quick')
const configName = ref('')
const resize = ref(false)
const chosenMethod = ref<SizeMethod>('widths')
const sizeValues = ref('800, 1600')
const box = ref('1920x1080')
const fit = ref('inside')
const matchOrientation = ref(false)
const formats = ref<string[]>(['webp'])
const qualityLevel = ref('')
const qualityCustom = ref('82')
const maxSize = ref('')
const nameTemplate = ref('')
const sharpen = ref(emptySharpen())

const phase = ref<'idle' | 'running' | 'done' | 'failed'>('idle')
const progress = ref<Progress>({ done: 0, total: 0 })
const failure = ref('')
const report = ref<BatchReport>()
let stopWatching: (() => void) | undefined

const sizeMethod = computed<SizeMethod>(() => (resize.value ? chosenMethod.value : 'original'))
const resizeMethods = computed(() =>
  (options.value?.sizeMethods ?? []).filter((method) => method !== 'original'),
)
const separator = computed(() => (props.cwd.includes('\\') ? '\\' : '/'))
const needsSharp = computed(() => failure.value.toLowerCase().includes('sharp'))
const chosenConfig = computed(() => configs.value.find((row) => row.name === configName.value))
const percent = computed(() =>
  progress.value.total > 0 ? Math.round((progress.value.done / progress.value.total) * 100) : 0,
)
const defaultTemplate = computed(
  () => options.value?.defaultTemplates[sizeMethod.value] ?? '{dir}/{name}.{format}',
)
const templateExample = computed(() => {
  const text = nameTemplate.value.trim() || defaultTemplate.value
  return text.replace(
    /\{([a-zA-Z]+)(?::(\d+))?\}/g,
    (_, token: string) => SAMPLE_TOKENS[token] ?? `{${token}}`,
  )
})
const problem = computed(() => {
  if (sources.value.length === 0) return 'Add at least one folder or image.'
  if (scanTotal.value === 0 && sources.value.length > 0)
    return 'No images found in the added sources.'
  if (placement.value === 'out' && outDir.value.trim() === '')
    return 'Choose the folder for the results.'
  if (mode.value === 'config' && configName.value === '') return 'Choose a saved config.'
  if (mode.value === 'quick' && placement.value !== 'replace' && formats.value.length === 0) {
    return 'Pick at least one format.'
  }
  return ''
})
const canRun = computed(() => problem.value === '' && phase.value !== 'running')

function onScanned(result: ScanResult | undefined): void {
  scanTotal.value = result?.total.files ?? 0
  if (sources.value.length > 0 && result === undefined) scanTotal.value = 1
}

function toggleFormat(format: string): void {
  formats.value = formats.value.includes(format)
    ? formats.value.filter((item) => item !== format)
    : [...formats.value, format]
}

function tokenLabel(token: string): string {
  return '{' + token + '}'
}

function chooseOut(paths: string[]): void {
  outDir.value = paths[0] ?? outDir.value
  browsingOut.value = false
}

function insertToken(token: string): void {
  nameTemplate.value = (nameTemplate.value || defaultTemplate.value) + `{${token}}`
}

function suggestOutDir(): void {
  const first = sources.value[0]
  if (outDir.value !== '' || !first) return
  const base = first.replace(/[\\/]+$/, '')
  outDir.value = `${base}${separator.value}converted`
}

function buildSettings(): Record<string, unknown> {
  const settings: Record<string, unknown> = { sizeMethod: sizeMethod.value }
  if (sizeMethod.value === 'size') {
    settings.box = box.value
    settings.fit = fit.value
    settings.matchOrientation = matchOrientation.value
  } else if (sizeMethod.value !== 'original') {
    settings.values = sizeValues.value
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number)
  }
  settings.formats = placement.value === 'replace' ? ['original'] : formats.value
  if (qualityLevel.value === 'custom') settings.quality = Number(qualityCustom.value)
  else if (qualityLevel.value) settings.quality = qualityLevel.value
  if (maxSize.value.trim()) settings.maxBytes = maxSize.value.trim()
  if (placement.value !== 'replace' && nameTemplate.value.trim()) {
    settings.name = nameTemplate.value.trim()
  }
  const sharpening = sharpenPayload(sharpen.value)
  if (sharpening) settings.sharpen = sharpening
  return settings
}

async function run(dryRun: boolean, installSharp = false): Promise<void> {
  if (!dryRun && placement.value === 'replace') {
    const sure = window.confirm(
      `This rewrites ${scanTotal.value} original file${scanTotal.value === 1 ? '' : 's'} in place.` +
        (backup.value
          ? ' The originals are copied to a backup folder first.'
          : ' No backup will be made.') +
        '\n\nContinue?',
    )
    if (!sure) return
  }
  stopWatching?.()
  phase.value = 'running'
  failure.value = ''
  report.value = undefined
  progress.value = { done: 0, total: 0 }
  try {
    const { jobId } = await api.post<{ jobId: string }>('/api/image-batch/run', {
      paths: sources.value,
      recursive: recursive.value,
      placement: placement.value,
      out: outDir.value,
      flat: flat.value,
      overwrite: overwrite.value,
      backup: backup.value,
      onlyIfSmaller: onlyIfSmaller.value,
      config: mode.value === 'config' ? configName.value : undefined,
      settings: mode.value === 'quick' ? buildSettings() : undefined,
      dryRun,
      installSharp,
    })
    stopWatching = watchJob<Progress, BatchReport>(jobId, {
      onProgress: (data) => {
        progress.value = data
      },
      onDone: (data) => {
        report.value = data
        phase.value = 'done'
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

onMounted(async () => {
  try {
    configs.value = await api.get<ConfigRow[]>('/api/image-batch/configs')
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
    phase.value = 'failed'
  }
})

onBeforeUnmount(() => stopWatching?.())
</script>

<template>
  <div class="view">
    <div v-if="options && !options.sharp" class="notice notice--warn">
      The sharp image library could not be loaded. Previews are limited, and the first run will
      offer to install it again.
    </div>

    <SourcePicker
      v-model:sources="sources"
      v-model:recursive="recursive"
      scan-url="/api/image-batch/scan"
      :start="cwd"
      @scanned="onScanned"
    />

    <section class="card block">
      <h2>Where the results go</h2>
      <UiSegmented
        v-model="placement"
        label="Placement"
        :options="[
          { value: 'out', label: 'A separate folder', hint: 'the sources are not touched' },
          { value: 'beside', label: 'Next to each original', hint: 'new files beside the sources' },
          {
            value: 'replace',
            label: 'Replace the originals',
            hint: 'rewrites the files, with a backup',
          },
        ]"
        @update:model-value="suggestOutDir"
      />

      <template v-if="placement === 'out'">
        <div class="pathrow">
          <input
            v-model="outDir"
            class="input"
            spellcheck="false"
            placeholder="Folder for the results"
            aria-label="Folder for the results"
          />
          <button class="btn" @click="browsingOut = true">
            <Icon name="folder" :size="16" /> Browse
          </button>
        </div>
        <label class="check">
          <input v-model="flat" type="checkbox" /> Put everything in one folder (no subfolders)
        </label>
      </template>
      <p v-else-if="placement === 'beside'" class="muted">
        Each result is written next to its original, with the size or format in the name.
      </p>
      <template v-else>
        <p class="notice notice--warn">
          Each original is overwritten with its converted version, keeping its own format. Use the
          preview first.
        </p>
        <label class="check"
          ><input v-model="backup" type="checkbox" /> Copy the originals to a backup folder
          first</label
        >
        <label class="check">
          <input v-model="onlyIfSmaller" type="checkbox" /> Replace a file only when the result is
          smaller
        </label>
      </template>

      <label v-if="placement !== 'replace'" class="field narrow">
        <span>If a result already exists</span>
        <select v-model="overwrite" class="select">
          <option value="skip">Skip it</option>
          <option value="overwrite">Overwrite it</option>
          <option value="error">Stop and report it</option>
        </select>
      </label>
    </section>

    <section class="card block">
      <div class="head">
        <h2>What to do</h2>
        <UiSegmented
          v-model="mode"
          label="Settings source"
          :options="[
            { value: 'quick', label: 'Quick settings' },
            { value: 'config', label: 'Saved config' },
          ]"
        />
      </div>

      <template v-if="mode === 'config'">
        <p v-if="configs.length === 0" class="muted">
          No configs yet.
          <button class="link" @click="navigate('configs')">Create the first one</button>
          or use quick settings.
        </p>
        <template v-else>
          <label class="field narrow">
            <span>Config</span>
            <select v-model="configName" class="select">
              <option value="" disabled>Choose a config…</option>
              <option
                v-for="row in configs"
                :key="row.name + row.scope"
                :value="row.name"
                :disabled="!!row.error"
              >
                {{ row.name }} · {{ row.scope }}
              </option>
            </select>
          </label>
          <button class="link" @click="navigate('configs')">Manage configs</button>
          <p v-if="chosenConfig" class="muted">
            <template v-if="chosenConfig.title">{{ chosenConfig.title }} — </template>
            {{ chosenConfig.recipes }} recipe{{ chosenConfig.recipes === 1 ? '' : 's' }}
            <template v-if="chosenConfig.rules"
              >, {{ chosenConfig.rules }} rule{{ chosenConfig.rules === 1 ? '' : 's' }}</template
            >
            <template v-if="chosenConfig.description"> · {{ chosenConfig.description }}</template>
          </p>
        </template>
      </template>

      <template v-else-if="options">
        <div class="group">
          <h3>Size</h3>
          <label class="check">
            <input v-model="resize" type="checkbox" /> Resize the images
          </label>
          <p v-if="!resize" class="muted small">
            The size does not change: the images are only converted to the chosen format.
          </p>
          <div v-if="resize" class="grid">
            <label class="field">
              <span>Method</span>
              <select v-model="chosenMethod" class="select">
                <option v-for="method in resizeMethods" :key="method" :value="method">
                  {{ METHOD_LABELS[method] }}
                </option>
              </select>
            </label>
            <label v-if="resize && sizeMethod === 'size'" class="field">
              <span>Box (width × height)</span>
              <input v-model="box" class="input" spellcheck="false" placeholder="1920x1080" />
            </label>
            <label v-else-if="resize" class="field">
              <span>Values</span>
              <input
                v-model="sizeValues"
                class="input"
                spellcheck="false"
                :placeholder="METHOD_HINTS[sizeMethod]"
              />
            </label>
            <label v-if="resize && sizeMethod === 'size'" class="field">
              <span>How it fills the box</span>
              <select v-model="fit" class="select">
                <option v-for="fitMode in options.fitModes" :key="fitMode" :value="fitMode">
                  {{ fitMode }}
                </option>
              </select>
            </label>
          </div>
          <label v-if="sizeMethod === 'size'" class="check">
            <input v-model="matchOrientation" type="checkbox" /> Turn the box around for portrait
            images
          </label>
          <p v-else-if="resize && METHOD_HINTS[sizeMethod]" class="muted small">
            {{ METHOD_HINTS[sizeMethod] }}. Images are never enlarged.
          </p>
        </div>

        <div class="group">
          <h3>Formats</h3>
          <p v-if="placement === 'replace'" class="muted small">
            Each file keeps its own format when the originals are replaced.
          </p>
          <div v-else class="pills">
            <label
              v-for="format in options.formats"
              :key="format"
              class="pill"
              :class="{ 'pill--on': formats.includes(format) }"
            >
              <input
                type="checkbox"
                :checked="formats.includes(format)"
                @change="toggleFormat(format)"
              />
              {{ format }}
            </label>
          </div>
          <div class="grid">
            <label class="field">
              <span>Quality</span>
              <select v-model="qualityLevel" class="select">
                <option value="">Default (high)</option>
                <option v-for="level in options.qualityLevels" :key="level" :value="level">
                  {{ level }}
                </option>
                <option value="custom">A number…</option>
              </select>
            </label>
            <label v-if="qualityLevel === 'custom'" class="field">
              <span>Quality (1–100)</span>
              <input v-model="qualityCustom" class="input" inputmode="numeric" />
            </label>
            <label class="field">
              <span>Largest file size</span>
              <input
                v-model="maxSize"
                class="input"
                spellcheck="false"
                placeholder="e.g. 200KB (optional)"
              />
            </label>
          </div>
        </div>

        <div v-if="placement !== 'replace'" class="group">
          <h3>File names</h3>
          <input
            v-model="nameTemplate"
            class="input"
            spellcheck="false"
            :placeholder="defaultTemplate"
            aria-label="File name template"
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
          <p class="muted small">
            Example: <code>{{ templateExample }}</code>
            <template v-if="!nameTemplate.trim()"> (the default for this size method)</template>
          </p>
        </div>

        <div class="group">
          <h3>Sharpening</h3>
          <SharpenSettings v-model="sharpen" :options="options" manage />
        </div>
      </template>
    </section>

    <div class="runbar">
      <button class="btn" :disabled="!canRun" @click="run(true)">Preview</button>
      <button class="btn btn--primary" :disabled="!canRun" @click="run(false)">
        <Icon name="play" :size="15" /> {{ phase === 'running' ? 'Working…' : 'Convert' }}
      </button>
      <span v-if="problem" class="muted">{{ problem }}</span>
    </div>

    <div v-if="phase === 'running'" class="card block" role="status">
      <div class="progress"><div class="progress__bar" :style="{ width: `${percent}%` }" /></div>
      <span class="muted">{{ progress.done }} of {{ progress.total || '…' }} files</span>
    </div>

    <div v-if="phase === 'failed'" class="notice notice--error">
      <p>{{ failure }}</p>
      <button v-if="needsSharp" class="btn btn--small" @click="run(false, true)">
        Install sharp and retry
      </button>
    </div>

    <BatchResults v-if="report" :report="report" />

    <FolderBrowser
      v-if="browsingOut"
      :start="outDir || sources[0] || cwd"
      mode="folder"
      title="Choose the folder for the results"
      @close="browsingOut = false"
      @confirm="chooseOut"
    />
  </div>
</template>

<style scoped lang="scss">
.view {
  @include stack($space-4);
}

.block {
  @include stack(14px);
  padding: 18px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
}

.group {
  @include stack($space-3 - 2);

  h3 {
    @include eyebrow;
  }
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.narrow {
  max-width: 320px;
}

.small {
  font-size: $font-size-sm;
}

.pathrow {
  display: flex;
  gap: $space-2;

  .input {
    flex: 1;
    font-family: $font-mono;
    font-size: $font-size-sm;
  }
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

.runbar {
  @include cluster(14px);
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
</style>
