<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../api'
import Icon from '../../components/Icon.vue'
import SharpenEditor from './SharpenEditor.vue'
import type { BatchOptions, SharpenPresetRow } from './types'

defineProps<{ options: BatchOptions; cwd: string }>()

const rows = ref<SharpenPresetRow[]>([])
const failure = ref('')
const note = ref('')
const mode = ref<'list' | 'edit'>('list')
const editing = ref<SharpenPresetRow>()
const copying = ref<SharpenPresetRow>()

async function load(): Promise<void> {
  try {
    rows.value = await api.get<SharpenPresetRow[]>('/api/image-batch/sharpen-presets')
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  }
}

function create(): void {
  editing.value = undefined
  copying.value = undefined
  mode.value = 'edit'
}

function edit(row: SharpenPresetRow): void {
  editing.value = row
  copying.value = undefined
  mode.value = 'edit'
}

function copy(row: SharpenPresetRow): void {
  editing.value = undefined
  copying.value = row
  mode.value = 'edit'
}

async function remove(row: SharpenPresetRow): Promise<void> {
  if (!window.confirm(`Delete the preset “${row.name}”? A .bak copy is kept next to it.`)) return
  try {
    await api.post('/api/image-batch/sharpen-preset/delete', { name: row.name, scope: row.scope })
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

function summary(row: SharpenPresetRow): string {
  return Object.entries(row.fields ?? {})
    .map(([key, value]) => `${key} ${value}`)
    .join(' · ')
}

onMounted(load)
</script>

<template>
  <div class="view">
    <SharpenEditor
      v-if="mode === 'edit'"
      :options="options"
      :cwd="cwd"
      :initial="editing"
      :copy-of="copying"
      @saved="saved"
      @cancel="mode = 'list'"
    />

    <template v-else>
      <section class="card block">
        <div class="head">
          <div>
            <h2>Sharpening presets</h2>
            <p class="muted">
              Save a set of sharpening values once and use it by name in any config or run.
            </p>
          </div>
          <button class="btn btn--primary" @click="create">
            <Icon name="plus" :size="16" /> New preset
          </button>
        </div>
        <p v-if="note" class="notice">{{ note }}</p>
        <p v-if="failure" class="notice notice--error">{{ failure }}</p>

        <ul class="list">
          <li v-for="row in rows" :key="row.scope + row.name" class="item">
            <div class="item__main">
              <div class="item__title">
                <strong>{{ row.name }}</strong>
                <span class="tag" :class="{ 'tag--builtin': row.scope === 'built-in' }">{{
                  row.scope
                }}</span>
              </div>
              <p v-if="row.error" class="item__error">{{ row.error }}</p>
              <template v-else>
                <p v-if="row.description" class="muted">{{ row.description }}</p>
                <p class="item__facts">
                  {{ summary(row) }}
                  <span v-if="row.params" class="muted">
                    — sigma {{ row.params.sigma }}, flat {{ row.params.m1 }}, jagged
                    {{ row.params.m2 }}
                  </span>
                </p>
              </template>
            </div>
            <div class="item__actions">
              <button
                v-if="row.scope !== 'built-in' && !row.error"
                class="btn btn--small"
                @click="edit(row)"
              >
                Edit
              </button>
              <button v-if="!row.error" class="btn btn--small" @click="copy(row)">
                {{ row.scope === 'built-in' ? 'Copy to my presets' : 'Duplicate' }}
              </button>
              <button
                v-if="row.scope !== 'built-in'"
                class="btn btn--small btn--danger"
                @click="remove(row)"
              >
                Delete
              </button>
            </div>
          </li>
        </ul>
      </section>
    </template>
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

  &__facts {
    font-family: $font-mono;
    font-size: $font-size-sm;
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

  &--builtin {
    background: var(--accent-soft);
    color: var(--accent);
  }
}
</style>
