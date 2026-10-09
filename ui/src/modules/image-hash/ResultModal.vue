<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { imageUrl } from '../../api'
import Icon from '../../components/Icon.vue'
import { useCopy } from '../../composables/useCopy'
import UiModal from '../../ui-components/UiModal.vue'
import PlaceholderCanvas from './PlaceholderCanvas.vue'
import { decodePlaceholder, type DecodableType, type ResultEntry } from './placeholders'

const props = defineProps<{ entries: ResultEntry[]; index: number }>()
const emit = defineEmits<{ close: []; 'update:index': [index: number] }>()

const DECODABLE: DecodableType[] = ['hazehash', 'blurhash', 'thumbhash']
const { copied, copy } = useCopy()

const entry = computed(() => props.entries[props.index] as ResultEntry)
const hasPrev = computed(() => props.index > 0)
const hasNext = computed(() => props.index < props.entries.length - 1)

const aspect = computed(() => {
  const { width, height } = entry.value
  return width > 0 && height > 0 ? width / height : 1
})

const decoded = computed(() =>
  DECODABLE.filter((type) => entry.value[type] !== undefined).map((type) => ({
    type,
    rgba: decodePlaceholder(
      type,
      entry.value[type] as string,
      entry.value.width,
      entry.value.height,
    ),
  })),
)

const lines = computed(() => {
  const found: { key: string; value: string }[] = []
  for (const key of ['hazehash', 'blurhash', 'thumbhash', 'color'] as const) {
    const value = entry.value[key]
    if (value !== undefined) found.push({ key, value })
  }
  return found
})

function go(step: number): void {
  const next = props.index + step
  if (next >= 0 && next < props.entries.length) emit('update:index', next)
}

function onKey(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement) return
  if (event.key === 'ArrowLeft') go(-1)
  if (event.key === 'ArrowRight') go(1)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <UiModal :title="entry.file" width="1040px" @close="emit('close')">
    <template #actions>
      <span class="muted counter">{{ index + 1 }} / {{ entries.length }}</span>
      <button
        class="btn btn--small"
        :disabled="!hasPrev"
        aria-label="Previous image"
        @click="go(-1)"
      >
        <Icon name="left" :size="15" />
      </button>
      <button class="btn btn--small" :disabled="!hasNext" aria-label="Next image" @click="go(1)">
        <Icon name="right" :size="15" />
      </button>
    </template>

    <div class="scroll">
      <div class="stage">
        <img
          :key="entry.path"
          class="stage__img"
          :alt="entry.file"
          :src="imageUrl(entry.path, 1600)"
        />
      </div>

      <div v-if="decoded.length" class="compare">
        <figure v-for="item in decoded" :key="item.type" class="compare__item">
          <div class="compare__frame" :style="{ aspectRatio: String(aspect) }">
            <PlaceholderCanvas :rgba="item.rgba" />
          </div>
          <figcaption>{{ item.type }}</figcaption>
        </figure>
        <figure v-if="entry.preview" class="compare__item">
          <div class="compare__frame" :style="{ aspectRatio: String(aspect) }">
            <img class="compare__preview" alt="Tiny preview" :src="entry.preview" />
          </div>
          <figcaption>preview</figcaption>
        </figure>
      </div>

      <dl class="facts">
        <div class="facts__row">
          <dt>File</dt>
          <dd class="facts__mono">{{ entry.path }}</dd>
        </div>
        <div class="facts__row">
          <dt>Size</dt>
          <dd>{{ entry.width }} × {{ entry.height }} px</dd>
        </div>
        <div v-for="line in lines" :key="line.key" class="facts__row">
          <dt>
            <span v-if="line.key === 'color'" class="swatch" :style="{ background: line.value }" />
            {{ line.key }}
          </dt>
          <dd class="facts__mono facts__hash">{{ line.value }}</dd>
          <button
            class="btn btn--ghost btn--small"
            :aria-label="`Copy ${line.key}`"
            @click="copy(line.key, line.value)"
          >
            <Icon :name="copied === line.key ? 'check' : 'copy'" :size="14" />
          </button>
        </div>
      </dl>
    </div>
  </UiModal>
</template>

<style scoped lang="scss">
.counter {
  font-size: $font-size-sm;
}

.scroll {
  @include stack($space-4);
  padding: $space-4;
  min-height: 0;
  @include scroll-area;
}

.stage {
  @include flex-center;
  padding: $space-3;
  border-radius: $radius-md;
  background: repeating-conic-gradient(var(--surface-2) 0% 25%, transparent 0% 50%) 50% / 20px 20px;

  &__img {
    display: block;
    max-width: 100%;
    max-height: 56vh;
    border-radius: $radius-sm;
    object-fit: contain;
  }
}

.compare {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: $space-3;

  &__item {
    @include stack($space-1 + 2);
    margin: 0;

    figcaption {
      @include eyebrow;
    }
  }

  &__frame {
    overflow: hidden;
    border-radius: $radius-md;
    background: var(--surface-2);
  }

  &__preview {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}

.facts {
  @include stack($space-1);
  margin: 0;

  &__row {
    display: flex;
    align-items: center;
    gap: $space-3;
    min-height: 32px;
  }

  dt {
    display: flex;
    align-items: center;
    gap: $space-2 - 2;
    flex: none;
    width: 96px;
    color: var(--muted);
    font-size: $font-size-sm;
  }

  dd {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  &__mono {
    font-family: $font-mono;
    font-size: $font-size-sm;
    word-break: break-all;
  }
}

.swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
</style>
