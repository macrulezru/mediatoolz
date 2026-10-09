<script setup lang="ts">
import { computed, onMounted, provide, ref } from 'vue'
import { api, type ModuleInfo, type StatusInfo } from '../../api'
import Icon from '../../components/Icon.vue'
import UiSegmented from '../../ui-components/UiSegmented.vue'
import BackupsView from './BackupsView.vue'
import ConfigsView from './ConfigsView.vue'
import ConvertView from './ConvertView.vue'
import { NAVIGATE, PROJECT, projectContext, type BatchTab } from './nav'
import SharpenView from './SharpenView.vue'
import type { BatchOptions } from './types'

const props = defineProps<{ module: ModuleInfo; status: StatusInfo | undefined }>()

const TAB_KEY = 'mediatoolz-ui.image-batch-tab'

function initialTab(): BatchTab {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved === 'convert' || saved === 'configs' || saved === 'sharpen' || saved === 'backups')
      return saved
  } catch {
    return 'convert'
  }
  return 'convert'
}

const tab = ref<BatchTab>(initialTab())
const options = ref<BatchOptions>()
const failure = ref('')

function go(next: BatchTab): void {
  tab.value = next
  try {
    localStorage.setItem(TAB_KEY, next)
  } catch {
    tab.value = next
  }
}

provide(NAVIGATE, go)
provide(
  PROJECT,
  computed(() => projectContext(props.status?.cwd ?? '', props.status?.home ?? '')).value,
)

onMounted(async () => {
  try {
    options.value = await api.get<BatchOptions>('/api/image-batch/options')
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  }
})
</script>

<template>
  <div class="page">
    <header class="page__head">
      <h1>{{ module.title }}</h1>
      <p class="muted">{{ module.description }}</p>
      <p
        v-if="status?.cwd"
        class="context"
        :title="`Everything marked “This project” lives in ${status.cwd}`"
      >
        <Icon name="folder" :size="15" />
        <span class="muted">Project folder</span>
        <code>{{ status.cwd }}</code>
      </p>
    </header>

    <UiSegmented
      :model-value="tab"
      label="Image Batch sections"
      :options="[
        { value: 'convert', label: 'Convert' },
        { value: 'configs', label: 'Configs' },
        { value: 'sharpen', label: 'Sharpening' },
        { value: 'backups', label: 'Backups' },
      ]"
      @update:model-value="go"
    />

    <p v-if="failure" class="notice notice--error">{{ failure }}</p>
    <template v-else-if="options">
      <ConvertView v-if="tab === 'convert'" :cwd="props.status?.cwd ?? ''" :options="options" />
      <ConfigsView v-else-if="tab === 'configs'" :options="options" />
      <SharpenView
        v-else-if="tab === 'sharpen'"
        :options="options"
        :cwd="props.status?.cwd ?? ''"
      />
      <BackupsView v-else :cwd="props.status?.cwd ?? ''" />
    </template>
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

.context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-2;
  margin-top: $space-2;
  font-size: $font-size-sm;

  code {
    padding: 2px 8px;
    border-radius: $radius-sm;
    background: var(--surface-2);
    word-break: break-all;
  }
}
</style>
