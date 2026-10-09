<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { api, formatBytes, imageUrl, type FsEntry, type FsListing } from '../api'
import UiModal from '../ui-components/UiModal.vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{ start: string; mode?: 'sources' | 'folder' | 'image'; title?: string }>(),
  {
    mode: 'sources',
    title: '',
  },
)
const emit = defineEmits<{
  close: []
  confirm: [paths: string[]]
}>()

const listing = ref<FsListing>()
const pathInput = ref(props.start)
const showHidden = ref(false)
const loading = ref(false)
const failure = ref('')
const picked = ref<Set<string>>(new Set())
const list = ref<HTMLElement>()
const positions = new Map<string, number>()

const separator = computed(() => (listing.value?.path.includes('\\') ? '\\' : '/'))
const entries = computed(() =>
  (listing.value?.entries ?? []).filter((entry) => props.mode !== 'folder' || entry.kind === 'dir'),
)
const imageCount = computed(
  () => listing.value?.entries.filter((entry) => entry.kind === 'image').length ?? 0,
)

function join(name: string): string {
  const base = listing.value?.path ?? ''
  return base.endsWith(separator.value) ? base + name : base + separator.value + name
}

function isInside(child: string, parent: string): boolean {
  const base = parent.endsWith('\\') || parent.endsWith('/') ? parent : parent + separator.value
  return child !== parent && child.startsWith(base)
}

async function load(path: string): Promise<void> {
  const previous = listing.value?.path
  if (previous !== undefined) positions.set(previous, list.value?.scrollTop ?? 0)
  loading.value = true
  failure.value = ''
  try {
    const result = await api.get<FsListing>(
      `/api/fs/list?path=${encodeURIComponent(path)}&hidden=${showHidden.value ? 1 : 0}`,
    )
    listing.value = result
    pathInput.value = result.path
    for (const saved of [...positions.keys()]) {
      if (isInside(saved, result.path)) positions.delete(saved)
    }
    await nextTick()
    list.value?.scrollTo({ top: positions.get(result.path) ?? 0 })
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

function enter(entry: FsEntry): void {
  if (entry.kind === 'dir') void load(join(entry.name))
}

function toggle(entry: FsEntry): void {
  const path = join(entry.name)
  const next = new Set(picked.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  picked.value = next
}

function onRow(entry: FsEntry): void {
  if (entry.kind === 'dir') enter(entry)
  else if (props.mode === 'image') emit('confirm', [join(entry.name)])
  else toggle(entry)
}

function addCurrent(): void {
  if (listing.value) emit('confirm', [listing.value.path])
}

function addPicked(): void {
  emit('confirm', [...picked.value])
}

onMounted(() => void load(props.start))
</script>

<template>
  <UiModal
    :title="
      title ||
      (mode === 'folder'
        ? 'Choose a folder'
        : mode === 'image'
          ? 'Choose an image'
          : 'Add folders or images')
    "
    fixed-height
    @close="emit('close')"
  >
    <div class="bar">
      <button
        class="btn btn--small"
        :disabled="!listing?.parent"
        title="Parent folder"
        @click="listing?.parent && load(listing.parent)"
      >
        <Icon name="up" :size="15" /> Up
      </button>
      <button class="btn btn--small" title="Home folder" @click="listing && load(listing.home)">
        <Icon name="home" :size="15" /> Home
      </button>
      <button class="btn btn--small" title="Start folder" @click="listing && load(listing.cwd)">
        Start folder
      </button>
      <select
        v-if="(listing?.roots.length ?? 0) > 1"
        class="select bar__roots"
        :value="listing?.root"
        aria-label="Drive"
        @change="load(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="root in listing?.roots" :key="root" :value="root">{{ root }}</option>
      </select>
      <form class="bar__path" @submit.prevent="load(pathInput)">
        <input v-model="pathInput" class="input" spellcheck="false" aria-label="Folder path" />
        <button class="btn btn--small" type="submit">Go</button>
      </form>
      <label class="check muted">
        <input v-model="showHidden" type="checkbox" @change="listing && load(listing.path)" />
        Hidden
      </label>
    </div>

    <div v-if="failure" class="notice notice--error notice-inset">{{ failure }}</div>

    <div ref="list" class="list" :aria-busy="loading">
      <div v-if="listing && entries.length === 0" class="muted empty">
        This folder has no subfolders or images.
      </div>
      <div
        v-for="entry in entries"
        :key="entry.name"
        class="row"
        :class="{ 'row--picked': picked.has(join(entry.name)) }"
      >
        <input
          v-if="mode === 'sources'"
          type="checkbox"
          :checked="picked.has(join(entry.name))"
          :aria-label="`Select ${entry.name}`"
          @change="toggle(entry)"
        />
        <button class="row__main" @click="onRow(entry)">
          <span v-if="entry.kind === 'dir'" class="row__icon"><Icon name="folder" /></span>
          <img
            v-else
            class="row__thumb"
            loading="lazy"
            alt=""
            :src="imageUrl(join(entry.name), 96)"
          />
          <span class="row__name">{{ entry.name }}</span>
          <span v-if="entry.size !== undefined" class="muted">{{ formatBytes(entry.size) }}</span>
        </button>
      </div>
      <div v-if="listing?.truncated" class="muted empty">Only the first entries are shown.</div>
    </div>

    <template #footer>
      <span class="muted">{{ imageCount }} image{{ imageCount === 1 ? '' : 's' }} here</span>
      <span class="spacer" />
      <button
        v-if="mode !== 'image'"
        class="btn"
        :class="{ 'btn--primary': mode === 'folder' }"
        :disabled="!listing"
        @click="addCurrent"
      >
        {{ mode === 'folder' ? 'Use this folder' : 'Add this folder' }}
      </button>
      <button
        v-if="mode === 'sources'"
        class="btn btn--primary"
        :disabled="picked.size === 0"
        @click="addPicked"
      >
        Add {{ picked.size }} selected
      </button>
    </template>
  </UiModal>
</template>

<style scoped lang="scss">
.bar {
  @include cluster;
  padding: $space-3 $space-4;

  &__path {
    display: flex;
    flex: 1;
    gap: $space-2 - 2;
    min-width: 200px;

    .input {
      flex: 1;
      height: $control-height-sm;
      font-family: $font-mono;
      font-size: $font-size-sm;
    }
  }

  &__roots {
    height: $control-height-sm;
  }
}

.notice-inset {
  margin: 0 $space-4 $space-3;
}

.spacer {
  flex: 1;
}

.list {
  flex: 1;
  min-height: 0;
  padding: 0 $space-2 $space-2;
  @include scroll-area;
}

.empty {
  padding: $space-6;
  text-align: center;
}

.row {
  display: flex;
  align-items: center;
  gap: $space-2;
  padding: 2px $space-2;
  border-radius: $radius-md;

  &:hover {
    background: var(--surface-2);
  }

  &--picked {
    background: var(--accent-soft);
  }

  &__main {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: $space-1 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  &__icon {
    @include icon-tile(40px);
    color: var(--accent);
  }

  &__thumb {
    width: 40px;
    height: 40px;
    border-radius: $radius-sm;
    background: var(--surface-2);
    object-fit: cover;
  }

  &__name {
    flex: 1;
    @include truncate;
  }
}
</style>
