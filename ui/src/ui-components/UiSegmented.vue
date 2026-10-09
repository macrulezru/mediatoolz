<script setup lang="ts" generic="T extends string">
defineProps<{ options: { value: T; label: string; hint?: string }[]; label?: string }>()
const model = defineModel<T>({ required: true })
</script>

<template>
  <div class="seg" role="radiogroup" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      class="seg__btn"
      :class="{ 'seg__btn--on': model === option.value }"
      role="radio"
      :aria-checked="model === option.value"
      :title="option.hint"
      @click="model = option.value"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped lang="scss">
.seg {
  display: inline-flex;
  align-self: flex-start;
  flex-wrap: wrap;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: $radius-md;
  background: var(--surface-2);

  &__btn {
    padding: 5px 12px;
    border: 0;
    border-radius: $radius-md - 3;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    @include focus-ring;

    &--on {
      background: var(--surface);
      color: var(--text);
      font-weight: 600;
      box-shadow: var(--shadow);
    }
  }
}
</style>
