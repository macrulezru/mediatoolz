<script setup lang="ts">
import { computed } from 'vue'
import { imageUrl } from '../../api'
import Icon from '../../components/Icon.vue'
import { useCopy } from '../../composables/useCopy'
import PlaceholderCanvas from './PlaceholderCanvas.vue'
import { decodePlaceholder, type DecodableType, type ResultEntry } from './placeholders'

const props = defineProps<{ entry: ResultEntry }>()
const emit = defineEmits<{ open: [] }>()

const DECODABLE: DecodableType[] = ['hazehash', 'blurhash', 'thumbhash']
const { copied, copy } = useCopy()

const aspect = computed(() => {
  const { width, height } = props.entry
  return width > 0 && height > 0 ? Math.min(Math.max(width / height, 0.5), 2) : 1
})

const decoded = computed(() =>
  DECODABLE.filter((type) => props.entry[type] !== undefined).map((type) => ({
    type,
    rgba: decodePlaceholder(
      type,
      props.entry[type] as string,
      props.entry.width,
      props.entry.height,
    ),
  })),
)

const lines = computed(() => {
  const found: { key: string; value: string }[] = []
  for (const key of ['hazehash', 'blurhash', 'thumbhash', 'color'] as const) {
    const value = props.entry[key]
    if (value !== undefined) found.push({ key, value })
  }
  return found
})
</script>

<template>
  <article class="item card">
    <button class="item__open" :aria-label="`Open ${entry.file}`" @click="emit('open')">
      <span class="shots" :style="{ aspectRatio: String(aspect) }">
        <img class="shot" loading="lazy" :alt="entry.file" :src="imageUrl(entry.path, 480)" />
      </span>
      <span
        v-if="decoded.length > 0"
        class="strip"
        :style="{ aspectRatio: String(aspect * decoded.length) }"
      >
        <span v-for="item in decoded" :key="item.type" class="strip__cell">
          <PlaceholderCanvas :rgba="item.rgba" />
          <span class="strip__label">{{ item.type }}</span>
        </span>
      </span>
      <img v-if="entry.preview" class="preview" alt="Tiny preview" :src="entry.preview" />
    </button>

    <div class="meta">
      <strong class="meta__name" :title="entry.path">{{ entry.file }}</strong>
      <span class="muted">{{ entry.width }}×{{ entry.height }}</span>
    </div>

    <ul class="hashes">
      <li v-for="line in lines" :key="line.key">
        <span class="hashes__key">
          <span v-if="line.key === 'color'" class="swatch" :style="{ background: line.value }" />
          {{ line.key }}
        </span>
        <code class="hashes__value" :title="line.value">{{ line.value }}</code>
        <button
          class="btn btn--ghost btn--small"
          :aria-label="`Copy ${line.key}`"
          @click="copy(line.key, line.value)"
        >
          <Icon :name="copied === line.key ? 'check' : 'copy'" :size="14" />
        </button>
      </li>
    </ul>
  </article>
</template>

<style scoped lang="scss">
.item {
  @include stack($space-3 - 2);
  padding: $space-3 - 2;
  min-width: 0;

  &__open {
    @include stack($space-3 - 2);
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: zoom-in;
    @include focus-ring;
  }
}

.shots {
  display: block;
  overflow: hidden;
  border-radius: $radius-md - 1;
  background: var(--surface-2);
}

.shot {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform $transition-fast;

  .item__open:hover & {
    transform: scale(1.02);
  }
}

.strip {
  display: flex;
  overflow: hidden;
  border-radius: $radius-md - 1;

  &__cell {
    position: relative;
    flex: 1;
  }

  &__label {
    position: absolute;
    left: $space-1;
    bottom: 3px;
    padding: 0 5px;
    border-radius: $space-1;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 10px;
  }
}

.preview {
  width: 100%;
  border-radius: $radius-md - 1;
}

.meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: $space-2;

  &__name {
    @include truncate;
  }
}

.hashes {
  @include stack(2px);
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    gap: $space-2;
  }

  &__key {
    display: flex;
    align-items: center;
    gap: $space-2 - 2;
    flex: none;
    width: 84px;
    color: var(--muted);
    font-size: $font-size-sm;
  }

  &__value {
    flex: 1;
    font-size: $font-size-sm;
    @include truncate;
  }
}

.swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1px solid var(--border);
  border-radius: $space-1;
}
</style>
