<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { Rgba } from './placeholders'

const props = defineProps<{ rgba: Rgba | null }>()
const canvas = ref<HTMLCanvasElement>()

function draw(): void {
  const element = canvas.value
  if (!element || !props.rgba) return
  element.width = props.rgba.width
  element.height = props.rgba.height
  const context = element.getContext('2d')
  if (!context) return
  const image = context.createImageData(props.rgba.width, props.rgba.height)
  image.data.set(props.rgba.data)
  context.putImageData(image, 0, 0)
}

onMounted(draw)
watch(() => props.rgba, draw)
</script>

<template>
  <canvas v-if="rgba" ref="canvas" class="canvas" />
  <div v-else class="canvas canvas--bad" title="Could not decode this hash">?</div>
</template>

<style scoped lang="scss">
.canvas {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: var(--surface-2);
}

.canvas--bad {
  @include grid-center;
  color: var(--danger);
}
</style>
