import { ref } from 'vue'

export function useCopy(resetMs = 1200) {
  const copied = ref('')

  async function copy(key: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      copied.value = key
      setTimeout(() => {
        if (copied.value === key) copied.value = ''
      }, resetMs)
    } catch {
      copied.value = ''
    }
  }

  return { copied, copy }
}
