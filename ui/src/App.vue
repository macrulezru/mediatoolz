<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, type ModuleInfo, type StatusInfo } from './api'
import Icon from './components/Icon.vue'
import { MODULE_VIEWS, iconFor } from './modules/registry'

const status = ref<StatusInfo>()
const failure = ref('')
const hash = ref(window.location.hash)

const modules = computed<ModuleInfo[]>(() => status.value?.modules ?? [])
const currentId = computed(() => {
  const wanted = hash.value.replace(/^#\/?/, '')
  const found = modules.value.find((module) => module.id === wanted)
  return found
    ? found.id
    : (modules.value.find((module) => module.status === 'available')?.id ?? '')
})
const current = computed(() => modules.value.find((module) => module.id === currentId.value))
const view = computed(() => MODULE_VIEWS[currentId.value])

function onHashChange(): void {
  hash.value = window.location.hash
}

function open(module: ModuleInfo): void {
  if (module.status !== 'available') return
  window.location.hash = `#/${module.id}`
}

onMounted(async () => {
  window.addEventListener('hashchange', onHashChange)
  try {
    status.value = await api.get<StatusInfo>('/api/status')
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
  }
})

onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand__mark"><Icon name="layers" :size="16" /></span>
        <span class="brand__name">mediatoolz</span>
      </div>
      <nav class="menu" aria-label="Modules">
        <button
          v-for="module in modules"
          :key="module.id"
          class="menu__item"
          :class="{
            'menu__item--active': module.id === currentId,
            'menu__item--planned': module.status !== 'available',
          }"
          :disabled="module.status !== 'available'"
          :aria-current="module.id === currentId ? 'page' : undefined"
          @click="open(module)"
        >
          <Icon :name="iconFor(module.id)" />
          <span class="menu__title">{{ module.title }}</span>
          <span v-if="module.status !== 'available'" class="menu__badge">soon</span>
        </button>
      </nav>
      <div class="sidebar__foot">
        <span v-if="status">v{{ status.version }}</span>
      </div>
    </aside>

    <main class="main">
      <div v-if="failure" class="notice notice--error page-pad">{{ failure }}</div>
      <template v-else-if="current && view">
        <component :is="view.component" :key="current.id" :module="current" :status="status" />
      </template>
      <div v-else-if="status" class="muted page-pad">Pick a module on the left.</div>
    </main>
  </div>
</template>

<style scoped lang="scss">
.shell {
  display: grid;
  grid-template-columns: $sidebar-width minmax(0, 1fr);
  height: 100%;

  @include respond-below(md) {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }
}

.sidebar {
  @include stack($space-5 - 2);
  padding: $space-5 - 2 $space-3;
  border-right: 1px solid var(--border);
  background: var(--surface);

  &__foot {
    margin-top: auto;
    padding: 0 $space-2;
    color: var(--muted);
    font-size: $font-size-sm;
  }

  @include respond-below(md) {
    flex-direction: row;
    align-items: center;
    gap: $space-3;
    padding: 10px $space-3;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;

    &__foot {
      display: none;
    }
  }
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 $space-2;

  &__mark {
    @include icon-tile(28px);
    border-radius: $radius-md - 1;
    background: var(--accent);
    color: var(--accent-ink);
  }

  &__name {
    font-size: $font-size-md;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
}

.menu {
  @include stack(2px);

  @include respond-below(md) {
    flex-direction: row;
  }

  &__item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border: 0;
    border-radius: $radius-md;
    background: transparent;
    text-align: left;
    cursor: pointer;
    @include hover-fill;
    @include focus-ring;

    &--active {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 600;
    }

    &--planned {
      color: var(--muted);
      cursor: default;
    }
  }

  &__title {
    flex: 1;
  }

  &__badge {
    padding: 1px 7px;
    border-radius: $radius-pill;
    background: var(--surface-2);
    font-size: $font-size-xs;
  }
}

.main {
  min-width: 0;
  overflow-y: auto;
}

.page-pad {
  margin: $space-6;
}
</style>
