<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { highlightLines, plainLines, type CodeToken } from './highlight'

const props = defineProps<{
  text: string
  lang: string
  focusLine?: number | undefined
  focusColumn?: number | undefined
}>()

const WINDOW = 400
const FULL_LIMIT = 1500

const lines = ref<CodeToken[][]>(plainLines(props.text))
const full = ref(false)
const scroller = ref<HTMLElement>()

const total = computed(() => lines.value.length)
const windowed = computed(() => !full.value && total.value > FULL_LIMIT)
const start = computed(() => {
  if (!windowed.value) return 0
  const focus = props.focusLine ?? 1
  return Math.max(0, Math.min(focus - 1 - WINDOW / 2, total.value - WINDOW))
})
const end = computed(() =>
  windowed.value ? Math.min(total.value, start.value + WINDOW) : total.value,
)
const visible = computed(() => lines.value.slice(start.value, end.value))
const gutter = computed(() => String(total.value).length)

async function render(): Promise<void> {
  lines.value = plainLines(props.text)
  lines.value = await highlightLines(props.text, props.lang)
  await nextTick()
  reveal()
}

function reveal(): void {
  const target = scroller.value?.querySelector('[data-focus="true"]')
  if (target instanceof HTMLElement && scroller.value) {
    const box = scroller.value
    box.scrollTop = target.offsetTop - box.clientHeight / 2 + target.clientHeight / 2
  }
}

watch(() => [props.text, props.lang], render)
watch(
  () => [props.focusLine, props.focusColumn],
  async () => {
    await nextTick()
    reveal()
  },
)
onMounted(render)
</script>

<template>
  <div ref="scroller" class="code" tabindex="0" role="region" aria-label="Source code">
    <p v-if="windowed" class="code__note">
      Showing lines {{ start + 1 }}–{{ end }} of {{ total }}.
      <button class="code__link" @click="((full = true), nextTick().then(reveal))">
        Show the whole file
      </button>
    </p>
    <div
      v-for="(line, index) in visible"
      :key="start + index"
      class="line"
      :class="{ 'line--focus': start + index + 1 === focusLine }"
      :data-focus="start + index + 1 === focusLine"
    >
      <span class="line__no" :style="{ width: `${gutter + 1}ch` }">{{ start + index + 1 }}</span>
      <span class="line__text"
        ><span
          v-for="(token, at) in line"
          :key="at"
          class="tok"
          :class="{ 'tok--bold': token.bold, 'tok--italic': token.italic }"
          :style="{
            '--light': token.light || 'var(--text)',
            '--dark': token.dark || 'var(--text)',
          }"
          >{{ token.text }}</span
        ><span v-if="!line.length || (line.length === 1 && line[0]?.text === '')"
          >&nbsp;</span
        ></span
      >
      <span
        v-if="start + index + 1 === focusLine && focusColumn"
        class="line__marker"
        :style="{ left: `calc(${gutter + 1}ch + ${Math.max(0, focusColumn - 1)}ch + 12px)` }"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.code {
  position: relative;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: $radius-md;
  background: var(--surface-2);
  font-family: $font-mono;
  font-size: $font-size-sm;
  line-height: 1.6;
  tab-size: 2;
  @include focus-ring;

  &__note {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 6px 12px;
    background: var(--warn-soft);
    color: var(--warn);
  }

  &__link {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
}

.line {
  position: relative;
  display: flex;
  min-width: max-content;

  &--focus {
    background: color-mix(in srgb, var(--warn) 22%, transparent);
    box-shadow: inset 3px 0 0 var(--warn);
  }

  &__no {
    flex: none;
    padding: 0 $space-3;
    color: var(--muted);
    text-align: right;
    user-select: none;
    box-sizing: content-box;
  }

  &__text {
    white-space: pre;
    padding-right: $space-4;
  }

  &__marker {
    position: absolute;
    bottom: 0;
    width: 1ch;
    height: 2px;
    background: var(--danger);
    pointer-events: none;
  }
}

.tok {
  color: var(--light);

  &--bold {
    font-weight: 600;
  }

  &--italic {
    font-style: italic;
  }

  @media (prefers-color-scheme: dark) {
    color: var(--dark);
  }
}
</style>
