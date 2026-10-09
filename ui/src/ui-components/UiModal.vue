<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '../components/Icon.vue'

const props = withDefaults(
  defineProps<{ title: string; width?: string; fixedHeight?: boolean }>(),
  {
    width: '820px',
    fixedHeight: false,
  },
)
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement>()

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.body.style.overflow = 'hidden'
  dialog.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <div class="overlay" @mousedown.self="emit('close')">
    <div
      ref="dialog"
      class="dialog"
      :class="{ 'dialog--fixed': props.fixedHeight }"
      :style="{ '--dialog-width': props.width }"
      role="dialog"
      aria-modal="true"
      :aria-label="props.title"
      tabindex="-1"
    >
      <header class="dialog__head">
        <h2 class="dialog__title">{{ props.title }}</h2>
        <slot name="actions" />
        <button class="btn btn--ghost btn--small" aria-label="Close" @click="emit('close')">
          <Icon name="close" />
        </button>
      </header>
      <div class="dialog__body">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="dialog__foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped lang="scss">
.overlay {
  position: fixed;
  inset: 0;
  z-index: $z-overlay;
  @include flex-center;
  padding: $space-5;
  overflow: hidden;
  background: var(--backdrop);
}

.dialog {
  @include surface;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  width: min(var(--dialog-width), 100%);
  max-height: 100%;
  outline: none;

  &--fixed {
    height: min(680px, 100%);
  }

  &__head,
  &__foot {
    display: flex;
    align-items: center;
    gap: $space-3 - 2;
    padding: $space-3 $space-4;
  }

  &__head {
    border-bottom: 1px solid var(--border);
  }

  &__title {
    flex: 1;
    font-size: $font-size-md;
    @include truncate;
  }

  &__body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  &__foot {
    border-top: 1px solid var(--border);
  }
}
</style>
