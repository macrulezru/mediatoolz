<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, formatBytes, imageUrl } from '../../api'
import FolderBrowser from '../../components/FolderBrowser.vue'
import Icon from '../../components/Icon.vue'

defineProps<{ cwd: string }>()

interface BackupRow {
  dir: string
  name: string
  createdAt: string
  cwd: string
  files: number
  bytesBefore: number
  bytesAfter: number
}

type RestoreStatus =
  'restored' | 'would-restore' | 'modified' | 'missing-backup' | 'damaged-backup' | 'error'

interface BackupEntry {
  path: string
  backup: string
  bytesBefore: number
  bytesAfter: number
  status: RestoreStatus
  message?: string
}

interface BackupDetail extends BackupRow {
  counts: Record<RestoreStatus, number>
  entries: BackupEntry[]
}

const OPEN_KEY = 'mediatoolz-ui.open-backup'
const PAGE = 30

const LABELS: Record<RestoreStatus, string> = {
  restored: 'restored',
  'would-restore': 'can be restored',
  modified: 'changed since',
  'missing-backup': 'copy missing',
  'damaged-backup': 'copy damaged',
  error: 'error',
}

const root = ref('')
const rows = ref<BackupRow[]>([])
const detail = ref<BackupDetail>()
const failure = ref('')
const note = ref('')
const busy = ref(false)
const force = ref(false)
const shown = ref(PAGE)
const customDir = ref('')
const browsing = ref(false)

const problems = computed(() => {
  const counts = detail.value?.counts
  if (!counts) return 0
  return counts.modified + counts['missing-backup'] + counts['damaged-backup'] + counts.error
})
const restorable = computed(() => detail.value?.counts['would-restore'] ?? 0)
const visible = computed(() => detail.value?.entries.slice(0, shown.value) ?? [])

function when(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function tone(status: RestoreStatus): string {
  if (status === 'would-restore' || status === 'restored') return 'good'
  return status === 'modified' ? 'warn' : 'bad'
}

function fail(error: unknown): void {
  failure.value = error instanceof Error ? error.message : String(error)
}

async function load(): Promise<void> {
  try {
    const result = await api.get<{ root: string; backups: BackupRow[] }>('/api/image-batch/backups')
    root.value = result.root
    rows.value = result.backups
  } catch (error) {
    fail(error)
  }
}

async function open(dir: string): Promise<void> {
  failure.value = ''
  note.value = ''
  force.value = false
  shown.value = PAGE
  try {
    detail.value = await api.get<BackupDetail>(
      `/api/image-batch/backup?dir=${encodeURIComponent(dir)}`,
    )
  } catch (error) {
    detail.value = undefined
    fail(error)
  }
}

function openCustom(paths?: string[]): void {
  const dir = paths?.[0] ?? customDir.value
  browsing.value = false
  if (dir.trim() === '') return
  customDir.value = dir
  void open(dir)
}

async function restore(): Promise<void> {
  const current = detail.value
  if (!current) return
  const count = force.value ? current.files : restorable.value
  const sure = window.confirm(
    `Put back ${count} original file${count === 1 ? '' : 's'} from this backup?` +
      (force.value ? ' Files changed after the replacement will be overwritten too.' : ''),
  )
  if (!sure) return
  busy.value = true
  try {
    const report = await api.post<{ counts: Record<RestoreStatus, number> }>(
      '/api/image-batch/backup/restore',
      { dir: current.dir, force: force.value },
    )
    note.value = `Restored ${report.counts.restored} file${report.counts.restored === 1 ? '' : 's'}.`
    await open(current.dir)
  } catch (error) {
    fail(error)
  } finally {
    busy.value = false
  }
}

async function remove(dir: string): Promise<void> {
  if (
    !window.confirm(
      'Delete this backup for good? The saved originals cannot be recovered afterwards.',
    )
  )
    return
  try {
    await api.post('/api/image-batch/backup/delete', { dir })
    note.value = 'The backup was deleted.'
    if (detail.value?.dir === dir) detail.value = undefined
    await load()
  } catch (error) {
    fail(error)
  }
}

onMounted(async () => {
  await load()
  try {
    const wanted = localStorage.getItem(OPEN_KEY)
    if (wanted) {
      localStorage.removeItem(OPEN_KEY)
      await open(wanted)
    }
  } catch {
    detail.value = undefined
  }
})
</script>

<template>
  <div class="view">
    <section v-if="!detail" class="card block">
      <div class="head">
        <div>
          <h2>Backups</h2>
          <p class="muted">
            “Replace the originals” copies each file here first, so a replacement can be undone.
          </p>
        </div>
      </div>
      <p v-if="note" class="notice">{{ note }}</p>
      <p v-if="failure" class="notice notice--error">{{ failure }}</p>
      <p v-if="rows.length === 0" class="muted">
        No backups in <code>{{ root }}</code> yet.
      </p>

      <ul class="list">
        <li v-for="row in rows" :key="row.dir" class="item">
          <div class="item__main">
            <strong>{{ when(row.createdAt) }}</strong>
            <span class="muted">
              {{ row.files }} file{{ row.files === 1 ? '' : 's' }} ·
              {{ formatBytes(row.bytesBefore) }} → {{ formatBytes(row.bytesAfter) }}
            </span>
            <code class="item__path" :title="row.dir">{{ row.dir }}</code>
          </div>
          <div class="item__actions">
            <button class="btn btn--small" @click="open(row.dir)">Open</button>
            <button class="btn btn--small btn--danger" @click="remove(row.dir)">Delete</button>
          </div>
        </li>
      </ul>

      <div class="custom">
        <h3>Another backup folder</h3>
        <p class="muted small">
          If you chose your own backup folder, pick the dated folder inside it (the one with a
          <code>journal.json</code>).
        </p>
        <form class="pathrow" @submit.prevent="openCustom()">
          <input
            v-model="customDir"
            class="input"
            spellcheck="false"
            placeholder="Path to the dated backup folder"
          />
          <button class="btn" type="button" @click="browsing = true">
            <Icon name="folder" :size="16" /> Browse
          </button>
          <button class="btn btn--primary" type="submit" :disabled="customDir.trim() === ''">
            Open
          </button>
        </form>
      </div>
    </section>

    <section v-else class="card block">
      <div class="head">
        <div>
          <h2>Backup of {{ when(detail.createdAt) }}</h2>
          <p class="muted">
            {{ detail.files }} file{{ detail.files === 1 ? '' : 's' }} ·
            {{ formatBytes(detail.bytesBefore) }} originals,
            {{ formatBytes(detail.bytesAfter) }} after the replacement
          </p>
          <code class="item__path">{{ detail.dir }}</code>
        </div>
        <button class="btn btn--ghost" @click="((detail = undefined), load())">
          <Icon name="close" :size="16" /> Back to the list
        </button>
      </div>

      <p v-if="note" class="notice">{{ note }}</p>
      <p v-if="failure" class="notice notice--error">{{ failure }}</p>

      <div class="chips">
        <span
          v-for="(count, status) in detail.counts"
          v-show="count > 0"
          :key="status"
          class="chip"
          :class="`chip--${tone(status as RestoreStatus)}`"
        >
          {{ count }} {{ LABELS[status as RestoreStatus] }}
        </span>
      </div>
      <p v-if="detail.counts.modified" class="notice notice--warn">
        {{ detail.counts.modified }} file{{ detail.counts.modified === 1 ? ' was' : 's were' }}
        changed after the replacement. They are left alone unless you tick the box below.
      </p>

      <div class="actions">
        <button
          class="btn btn--primary"
          :disabled="busy || (restorable === 0 && !force)"
          @click="restore"
        >
          Restore {{ force ? 'everything' : `${restorable} file${restorable === 1 ? '' : 's'}` }}
        </button>
        <label v-if="detail.counts.modified" class="check">
          <input v-model="force" type="checkbox" /> Overwrite files that changed since
        </label>
        <button class="btn btn--danger" @click="remove(detail.dir)">Delete this backup</button>
      </div>

      <ul class="rows">
        <li v-for="entry in visible" :key="entry.path" class="row">
          <img
            class="row__thumb"
            loading="lazy"
            alt="Original"
            :src="imageUrl(entry.backup, 120)"
          />
          <span class="row__arrow muted">⇄</span>
          <img class="row__thumb" loading="lazy" alt="Now" :src="imageUrl(entry.path, 120)" />
          <div class="row__text">
            <span class="row__name" :title="entry.path">{{ entry.path }}</span>
            <span class="muted small">
              original {{ formatBytes(entry.bytesBefore) }} · replaced with
              {{ formatBytes(entry.bytesAfter) }}
            </span>
            <span v-if="entry.message" class="small row__message">{{ entry.message }}</span>
          </div>
          <span class="chip" :class="`chip--${tone(entry.status)}`">{{
            LABELS[entry.status]
          }}</span>
        </li>
      </ul>
      <div v-if="detail && shown < detail.entries.length" class="actions">
        <button class="btn" @click="shown += PAGE">
          Show more ({{ detail.entries.length - shown }} left)
        </button>
        <button class="btn" @click="shown = detail.entries.length">
          Show all ({{ detail.entries.length }})
        </button>
      </div>
      <p v-if="problems" class="muted small">
        The left picture is the saved original, the right one is the file as it is now on disk.
      </p>
    </section>

    <FolderBrowser
      v-if="browsing"
      :start="cwd"
      mode="folder"
      title="Choose the backup folder"
      @close="browsing = false"
      @confirm="openCustom"
    />
  </div>
</template>

<style scoped lang="scss">
.view {
  @include stack($space-4);
}

.block {
  @include stack($space-3);
  padding: 18px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: $space-3;
}

.small {
  font-size: $font-size-sm;
}

.list {
  @include stack($space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
  padding: $space-3;
  border: 1px solid var(--border);
  border-radius: $radius-md;

  &__main {
    @include stack(2px);
    flex: 1;
    min-width: 260px;
  }

  &__path {
    color: var(--muted);
    font-size: $font-size-xs;
    word-break: break-all;
  }

  &__actions {
    @include cluster;
  }
}

.custom {
  @include stack($space-2);
  padding-top: $space-3;
  border-top: 1px solid var(--border);

  h3 {
    @include eyebrow;
  }
}

.pathrow {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;

  .input {
    flex: 1;
    min-width: 220px;
    font-family: $font-mono;
    font-size: $font-size-sm;
  }
}

.actions {
  @include cluster($space-3);
}

.chips {
  @include cluster;
}

.chip {
  padding: 2px 10px;
  border-radius: $radius-pill;
  background: var(--surface-2);
  font-size: $font-size-sm;
  white-space: nowrap;

  &--good {
    background: color-mix(in srgb, var(--ok) 18%, transparent);
    color: var(--ok);
  }

  &--warn {
    background: var(--warn-soft);
    color: var(--warn);
  }

  &--bad {
    background: var(--danger-soft);
    color: var(--danger);
  }
}

.rows {
  @include stack($space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  align-items: center;
  gap: $space-3;
  padding: $space-2;
  border: 1px solid var(--border);
  border-radius: $radius-md;

  &__thumb {
    flex: none;
    width: 64px;
    height: 64px;
    border-radius: $radius-sm;
    background: var(--surface-2);
    object-fit: cover;
  }

  &__text {
    @include stack(2px);
    flex: 1;
    min-width: 0;
  }

  &__name {
    font-family: $font-mono;
    font-size: $font-size-sm;
    @include truncate;
  }

  &__message {
    color: var(--danger);
  }
}
</style>
