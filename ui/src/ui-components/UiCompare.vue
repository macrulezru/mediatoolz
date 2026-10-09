<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ before: string; after: string; beforeLabel?: string; afterLabel?: string }>()

const position = ref(50)
const loading = ref(true)
</script>

<template>
  <div class="compare" :aria-busy="loading">
    <div class="compare__scroll">
      <div class="compare__stage">
        <img class="compare__img" alt="Before" :src="before" @load="loading = false" />
        <img
          class="compare__img compare__img--top"
          alt="After"
          :src="after"
          :style="{ clipPath: `inset(0 0 0 ${position}%)` }"
        />
        <span class="compare__line" :style="{ left: `${position}%` }" />
        <span class="compare__tag compare__tag--left">{{ beforeLabel ?? 'Before' }}</span>
        <span class="compare__tag compare__tag--right">{{ afterLabel ?? 'After' }}</span>
      </div>
    </div>
    <input
      v-model.number="position"
      class="compare__range"
      type="range"
      min="0"
      max="100"
      aria-label="Comparison position"
    />
  </div>
</template>

<style scoped lang="scss">
.compare {
  @include stack($space-2);

  &__scroll {
    overflow: auto;
    border-radius: $radius-md;
    background: var(--surface-2);
    max-height: 70vh;
  }

  &__stage {
    position: relative;
    width: fit-content;
    margin: 0 auto;
    line-height: 0;
  }

  &__img {
    display: block;
    max-width: none;

    &--top {
      position: absolute;
      inset: 0;
    }
  }

  &__line {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--accent);
    pointer-events: none;
  }

  &__tag {
    position: absolute;
    top: $space-2;
    padding: 2px 8px;
    border-radius: $radius-sm;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: $font-size-xs;
    line-height: 1.4;

    &--left {
      left: $space-2;
    }

    &--right {
      right: $space-2;
    }
  }

  &__range {
    width: 100%;
  }
}
</style>
