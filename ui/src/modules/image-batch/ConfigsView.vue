<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../api'
import Icon from '../../components/Icon.vue'
import ConfigEditor from './ConfigEditor.vue'
import type { Raw } from './recipe'
import type { BatchOptions, ConfigRow } from './types'

defineProps<{ options: BatchOptions }>()

const rows = ref<ConfigRow[]>([])
const failure = ref('')
const note = ref('')
const mode = ref<'list' | 'edit'>('list')
const editing = ref<ConfigRow>()
const copying = ref<{ name: string; raw: Raw }>()

async function load(): Promise<void> {
  try {
    rows.value = await api.get<ConfigRow[]>('/api/image-batch/configs')
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  }
}

function create(): void {
  editing.value = undefined
  copying.value = undefined
  mode.value = 'edit'
}

function edit(row: ConfigRow): void {
  editing.value = row
  copying.value = undefined
  mode.value = 'edit'
}

async function duplicate(row: ConfigRow): Promise<void> {
  try {
    const loaded = await api.get<{ raw: Raw }>(
      `/api/image-batch/config?name=${encodeURIComponent(row.name)}&scope=${row.scope}`,
    )
    editing.value = undefined
    copying.value = { name: row.name, raw: loaded.raw }
    mode.value = 'edit'
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  }
}

async function remove(row: ConfigRow): Promise<void> {
  if (!window.confirm(`Delete the config “${row.name}”? A .bak copy is kept next to it.`)) return
  try {
    await api.post('/api/image-batch/config/delete', { name: row.name, scope: row.scope })
    note.value = `Deleted ${row.name}.`
    await load()
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  }
}

async function saved(name: string): Promise<void> {
  mode.value = 'list'
  note.value = `Saved ${name}.`
  await load()
}

onMounted(load)
</script>

<template>
  <div class="view">
    <ConfigEditor
      v-if="mode === 'edit'"
      :options="options"
      :initial="editing ? { name: editing.name, scope: editing.scope } : undefined"
      :copy-of="copying"
      @saved="saved"
      @cancel="mode = 'list'"
    />

    <section v-else class="card block">
      <div class="head">
        <div>
          <h2>Configs</h2>
          <p class="muted">
            A config is a reusable set of rules: sizes, formats, quality, names, sharpening. Apply
            it to any folder from the Convert tab.
          </p>
        </div>
        <button class="btn btn--primary" @click="create">
          <Icon name="plus" :size="16" /> New config
        </button>
      </div>
      <p v-if="note" class="notice">{{ note }}</p>
      <p v-if="failure" class="notice notice--error">{{ failure }}</p>
      <p v-if="rows.length === 0 && !failure" class="muted">
        No configs yet. Create the first one, or use quick settings on the Convert tab.
      </p>

      <ul class="list">
        <li v-for="row in rows" :key="row.scope + row.name + row.path" class="item">
          <div class="item__main">
            <div class="item__title">
              <strong>{{ row.name }}</strong>
              <span class="tag">{{ row.scope }}</span>
              <span v-if="row.kind !== 'json'" class="tag">.{{ row.kind }}</span>
            </div>
            <p v-if="row.error" class="item__error">{{ row.error }}</p>
            <p v-else class="muted">
              <template v-if="row.title">{{ row.title }} — </template>
              {{ row.recipes }} recipe{{ row.recipes === 1 ? '' : 's' }}
              <template v-if="row.rules"
                >, {{ row.rules }} rule{{ row.rules === 1 ? '' : 's' }}</template
              >
              <template v-if="row.description"> · {{ row.description }}</template>
            </p>
            <code class="item__path" :title="row.path">{{ row.path }}</code>
          </div>
          <div class="item__actions">
            <button v-if="row.editable" class="btn btn--small" @click="edit(row)">Edit</button>
            <button
              v-if="row.editable && !row.error"
              class="btn btn--small"
              @click="duplicate(row)"
            >
              Duplicate
            </button>
            <button class="btn btn--small btn--danger" @click="remove(row)">Delete</button>
          </div>
        </li>
      </ul>
    </section>
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

  &__title {
    display: flex;
    align-items: center;
    gap: $space-2;
  }

  &__path {
    color: var(--muted);
    font-size: $font-size-xs;
    word-break: break-all;
  }

  &__error {
    color: var(--danger);
    font-size: $font-size-sm;
  }

  &__actions {
    @include cluster;
  }
}

.tag {
  padding: 1px 8px;
  border-radius: $radius-pill;
  background: var(--surface-2);
  color: var(--muted);
  font-size: $font-size-xs;
}
</style>
