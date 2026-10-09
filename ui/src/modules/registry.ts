import { defineAsyncComponent, type Component } from 'vue'

export interface ModuleView {
  icon: string
  component: Component
}

export const MODULE_VIEWS: Record<string, ModuleView> = {
  'image-hash': {
    icon: 'image',
    component: defineAsyncComponent(() => import('./image-hash/ImageHashPage.vue')),
  },
  'image-batch': {
    icon: 'layers',
    component: defineAsyncComponent(() => import('./image-batch/ImageBatchPage.vue')),
  },
}

export const PLANNED_ICONS: Record<string, string> = {}

export function iconFor(id: string): string {
  return MODULE_VIEWS[id]?.icon ?? PLANNED_ICONS[id] ?? 'layers'
}
