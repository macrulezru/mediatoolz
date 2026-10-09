<script setup lang="ts">
const props = defineProps<{ name: string; size?: number }>()

const PATHS: Record<string, string[]> = {
  image: [
    'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
    'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'm20 15-4.5-4.5L6 20',
  ],
  layers: ['m12 3 9 5-9 5-9-5z', 'm3 13 9 5 9-5', 'm3 17.5 9 5 9-5'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  up: ['m12 19V5', 'm5 12 7-7 7 7'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'm20 20-4-4'],
  down: ['m12 5v14', 'm5 12 7 7 7-7'],
  left: ['m15 5-7 7 7 7'],
  right: ['m9 5 7 7-7 7'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  save: ['M5 4h11l3 3v13H5z', 'M8 4v5h7V4', 'M8 20v-6h8v6'],
  download: ['M12 4v11', 'm7 11 5 5 5-5', 'M5 20h14'],
  play: ['m7 4 13 8-13 8z'],
  check: ['m5 12 5 5 9-10'],
  home: ['m3 11 9-8 9 8', 'M5 10v10h14V10'],
  external: [
    'M14 4h6v6',
    'M20 4 11 13',
    'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  ],
}
</script>

<template>
  <svg
    :width="props.size ?? 18"
    :height="props.size ?? 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="path in PATHS[props.name] ?? []" :key="path" :d="path" />
  </svg>
</template>
