<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { api, formatBytes } from '../api'
import FolderBrowser from './FolderBrowser.vue'
import Icon from './Icon.vue'

export interface ScanSource {
  path: string
  exists: boolean
  kind: 'folder' | 'file' | 'missing'
  files: number
  folders: number
  bytes: number
}

export interface ScanResult {
  sources: ScanSource[]
  total: { files: number; folders: number; bytes: number }
}

const props = defineProps<{ scanUrl: string; start: string; title?: string }>()
const sources = defineModel<string[]>('sources', { required: true })
const recursive = defineModel<boolean>('recursive', { required: true })
const emit = defineEmits<{ scanned: [result: ScanResult | undefined] }>()

const browsing = ref(false)
const scanned = ref<ScanResult>()
const scanning = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let token = 0

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function statsFor(path: string): ScanSource | undefined {
  return scanned.value?.sources.find((source) => source.path === path)
}

function describe(stats: ScanSource | undefined): string {
  if (!stats) return scanning.value ? '…' : ''
  if (!stats.exists) return 'not found'
  if (stats.kind === 'file') return formatBytes(stats.bytes)
  if (stats.files === 0) return 'no images'
  return `${plural(stats.files, 'image')} · ${plural(stats.folders, 'folder')} · ${formatBytes(stats.bytes)}`
}

function add(paths: string[]): void {
  sources.value = [...new Set([...sources.value, ...paths])]
  browsing.value = false
}

function remove(path: string): void {
  sources.value = sources.value.filter((source) => source !== path)
}

function schedule(): void {
  clearTimeout(timer)
  if (sources.value.length === 0) {
    scanned.value = undefined
    scanning.value = false
    emit('scanned', undefined)
    return
  }
  scanning.value = true
  timer = setTimeout(async () => {
    const mine = ++token
    try {
      const result = await api.post<ScanResult>(props.scanUrl, {
        paths: sources.value,
        recursive: recursive.value,
      })
      if (mine === token) {
        scanned.value = result
        emit('scanned', result)
      }
    } catch {
      if (mine === token) {
        scanned.value = undefined
        emit('scanned', undefined)
      }
    } finally {
      if (mine === token) scanning.value = false
    }
  }, 200)
}

watch([sources, recursive], schedule, { deep: true, immediate: true })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <section class="card block">
    <div class="block__head">
      <h2>{{ title ?? 'Images' }}</h2>
      <button class="btn" @click="browsing = true">
        <Icon name="plus" :size="16" /> Add folder or images
      </button>
    </div>
    <p v-if="sources.length === 0" class="muted">
      Add the folders and images to process. Subfolders are included when the box below is ticked.
    </p>
    <ul v-else class="sources">
      <li
        v-for="source in sources"
        :key="source"
        class="source"
        :class="{ 'source--bad': statsFor(source)?.exists === false }"
      >
        <Icon :name="statsFor(source)?.kind === 'file' ? 'image' : 'folder'" :size="16" />
        <span class="source__path" :title="source">{{ source }}</span>
        <span class="source__stats">{{ describe(statsFor(source)) }}</span>
        <button class="source__x" :aria-label="`Remove ${source}`" @click="remove(source)">
          <Icon name="close" :size="14" />
        </button>
      </li>
    </ul>
    <label class="check"><input v-model="recursive" type="checkbox" /> Include subfolders</label>
    <p
      v-if="sources.length > 0"
      class="summary"
      :class="{ 'summary--warn': scanned && scanned.total.files === 0 }"
      role="status"
    >
      <template v-if="scanning && !scanned">Counting images…</template>
      <template v-else-if="scanned && scanned.total.files === 0">
        No images found. Check the paths{{ recursive ? '' : ' or tick "Include subfolders"' }}.
      </template>
      <template v-else-if="scanned">
        <strong>{{ plural(scanned.total.files, 'image') }}</strong>
        in {{ plural(scanned.total.folders, 'folder') }} · {{ formatBytes(scanned.total.bytes) }}
        <span v-if="scanning" class="muted">· updating…</span>
      </template>
    </p>

    <FolderBrowser
      v-if="browsing"
      :start="sources[0] ?? start"
      @close="browsing = false"
      @confirm="add"
    />
  </section>
</template>

<style scoped lang="scss">
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

.sources {
  @include stack($space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.source {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 6px 6px $space-3;
  border-radius: $radius-md;
  background: var(--surface-2);

  &--bad {
    background: var(--danger-soft);
    color: var(--danger);
  }

  &__path {
    flex: 1;
    min-width: 0;
    font-family: $font-mono;
    font-size: $font-size-sm;
    @include truncate;
  }

  &__stats {
    flex: none;
    color: var(--muted);
    font-size: $font-size-sm;
  }

  &--bad &__stats {
    color: inherit;
  }

  &__x {
    @include icon-tile(24px);
    flex: none;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    cursor: pointer;

    &:hover {
      background: rgba(127, 127, 127, 0.2);
    }
  }

  @include respond-below(sm) {
    flex-wrap: wrap;

    &__stats {
      order: 3;
      width: 100%;
    }
  }
}

.summary {
  padding: 10px 14px;
  border-radius: $radius-md;
  background: var(--accent-soft);

  &--warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
}
</style>
