<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, api } from '../../api'
import FolderBrowser from '../../components/FolderBrowser.vue'
import Icon from '../../components/Icon.vue'
import { EMPTY_PROJECT, PROJECT } from './nav'
import UiCompare from '../../ui-components/UiCompare.vue'
import type { BatchOptions, SharpenPresetRow } from './types'

const props = defineProps<{
  options: BatchOptions
  cwd: string
  initial?: SharpenPresetRow | undefined
  copyOf?: SharpenPresetRow | undefined
}>()
const emit = defineEmits<{ saved: [name: string]; cancel: [] }>()
const project = inject(PROJECT, EMPTY_PROJECT)

const FINE = ['radius', 'flat', 'jagged', 'threshold'] as const
const SAMPLE_KEY = 'mediatoolz-ui.sharpen-sample'

function seed(): SharpenPresetRow | undefined {
  return props.initial ?? props.copyOf
}

function initialFine(key: (typeof FINE)[number]): string {
  const value = seed()?.fields?.[key]
  return value === undefined ? '' : String(value)
}

const editing = computed(() => props.initial !== undefined)
const name = ref(props.initial ? props.initial.name : (props.copyOf?.name ?? ''))
const scope = ref<'project' | 'global'>(
  props.initial && props.initial.scope !== 'built-in' ? props.initial.scope : 'project',
)
const description = ref(seed()?.description ?? '')
const target = ref(String(seed()?.fields?.for ?? ''))
const amount = ref(String(seed()?.fields?.amount ?? ''))
const fine = ref<Record<(typeof FINE)[number], string>>({
  radius: initialFine('radius'),
  flat: initialFine('flat'),
  jagged: initialFine('jagged'),
  threshold: initialFine('threshold'),
})

const sample = ref('')
const width = ref('800')
const browsing = ref(false)
const params = ref<{ sigma: number; m1: number; m2: number; x1?: number }>()
const paramsError = ref('')
const failure = ref('')
const saving = ref(false)
const applied = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

const rangeOf = computed(() =>
  Object.fromEntries(props.options.sharpen.fine.map((entry) => [entry.key, entry.range])),
)

function fields(): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (target.value) result.for = target.value
  if (amount.value) result.amount = amount.value
  for (const key of FINE) {
    if (fine.value[key].trim() !== '') result[key] = Number(fine.value[key])
  }
  return result
}

function query(sharpen: boolean): string {
  const search = new URLSearchParams({ path: sample.value, width: width.value || '800' })
  if (sharpen) {
    search.set('sharpen', '1')
    for (const [key, value] of Object.entries(fields())) search.set(key, String(value))
  }
  return `/api/image-batch/sharpen-preview?${search.toString()}&v=${applied.value}`
}

const beforeUrl = computed(() => (sample.value ? query(false) : ''))
const afterUrl = computed(() => (sample.value ? query(true) : ''))

async function refresh(): Promise<void> {
  try {
    const result = await api.post<{ params: typeof params.value }>(
      '/api/image-batch/sharpen-preset/params',
      { fields: fields() },
    )
    params.value = result.params
    paramsError.value = ''
  } catch (error) {
    params.value = undefined
    paramsError.value = error instanceof Error ? error.message : String(error)
  }
  applied.value = JSON.stringify(fields()) + width.value
}

function schedule(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void refresh(), 300)
}

watch([target, amount, fine, width], schedule, { deep: true })

function chooseSample(paths: string[]): void {
  sample.value = paths[0] ?? ''
  browsing.value = false
  try {
    localStorage.setItem(SAMPLE_KEY, sample.value)
  } catch {
    sample.value = paths[0] ?? ''
  }
}

async function save(overwrite = false): Promise<void> {
  saving.value = true
  failure.value = ''
  try {
    await api.post('/api/image-batch/sharpen-preset/save', {
      name: name.value,
      scope: scope.value,
      description: description.value,
      fields: fields(),
      overwrite,
      ...(props.initial
        ? { originalName: props.initial.name, originalScope: props.initial.scope }
        : {}),
    })
    emit('saved', name.value)
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
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

onMounted(() => {
  try {
    sample.value = localStorage.getItem(SAMPLE_KEY) ?? ''
  } catch {
    sample.value = ''
  }
  void refresh()
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <section class="card block">
    <div class="head">
      <h2>
        {{
          editing ? 'Edit preset' : copyOf ? 'Copy of a built-in preset' : 'New sharpening preset'
        }}
      </h2>
      <button class="btn btn--ghost" @click="emit('cancel')">
        <Icon name="close" :size="16" /> Close
      </button>
    </div>

    <div class="grid">
      <label class="field">
        <span>Name</span>
        <input v-model="name" class="input" spellcheck="false" placeholder="web-crisp" />
      </label>
      <label class="field">
        <span>Where to keep it</span>
        <select v-model="scope" class="select">
          <option value="project">This project ({{ project.name }})</option>
          <option value="global">All projects (your home folder)</option>
        </select>
      </label>
      <label class="field wide">
        <span>Note (optional)</span>
        <input v-model="description" class="input" placeholder="What it is for" />
      </label>
    </div>

    <div class="grid">
      <label class="field">
        <span>Sharpen for</span>
        <select v-model="target" class="select">
          <option value="">Default (screen)</option>
          <option v-for="item in options.sharpen.targets" :key="item" :value="item">
            {{ item }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>Amount</span>
        <select v-model="amount" class="select">
          <option value="">Default (standard)</option>
          <option v-for="item in options.sharpen.amounts" :key="item" :value="item">
            {{ item }}
          </option>
        </select>
      </label>
    </div>

    <div class="grid">
      <label v-for="key in FINE" :key="key" class="field">
        <span>
          {{ key }}
          <small class="muted">({{ rangeOf[key]?.[0] }}–{{ rangeOf[key]?.[1] }})</small>
        </span>
        <input
          v-model="fine[key]"
          class="input"
          inputmode="decimal"
          placeholder="value from the table"
        />
      </label>
    </div>

    <p v-if="paramsError" class="notice notice--error">{{ paramsError }}</p>
    <p v-else-if="params" class="muted small">
      sharp receives: sigma {{ params.sigma }}, flat {{ params.m1 }}, jagged {{ params.m2
      }}<template v-if="params.x1 !== undefined">, threshold {{ params.x1 }}</template>
    </p>

    <div class="preview">
      <div class="head">
        <h3>Preview</h3>
        <div class="previewbar">
          <label class="field inline">
            <span>Width</span>
            <input
              v-model="width"
              class="input narrow"
              inputmode="numeric"
              aria-label="Preview width"
            />
          </label>
          <button class="btn btn--small" @click="browsing = true">
            <Icon name="image" :size="15" /> {{ sample ? 'Change image' : 'Choose an image' }}
          </button>
        </div>
      </div>
      <p v-if="!sample" class="muted">
        Pick any photo to see the preset applied at the output size. Drag the slider to compare.
      </p>
      <UiCompare
        v-else-if="!paramsError"
        :key="sample"
        :before="beforeUrl"
        :after="afterUrl"
        before-label="Without sharpening"
        after-label="Sharpened"
      />
      <p v-if="sample" class="muted small">
        {{ sample }} — resized to {{ width || 800 }} px wide, then sharpened, as it would be at the
        output size.
      </p>
    </div>

    <p v-if="failure" class="notice notice--error">{{ failure }}</p>
    <div class="actions">
      <button
        class="btn btn--primary"
        :disabled="saving || name.trim() === ''"
        @click="save(false)"
      >
        <Icon name="save" :size="15" /> Save preset
      </button>
      <button class="btn" @click="emit('cancel')">Cancel</button>
    </div>

    <FolderBrowser
      v-if="browsing"
      :start="sample ? sample.replace(/[\\/][^\\/]*$/, '') : cwd"
      mode="image"
      @close="browsing = false"
      @confirm="chooseSample"
    />
  </section>
</template>

<style scoped lang="scss">
.block {
  @include stack($space-4);
  padding: 18px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 14px;
}

.wide {
  grid-column: 1 / -1;
}

.small {
  font-size: $font-size-sm;
}

.preview {
  @include stack($space-3);
}

.previewbar {
  @include cluster;
}

.inline {
  flex-direction: row;
  align-items: center;
}

.narrow {
  width: 90px;
}

.actions {
  @include cluster;
}
</style>
