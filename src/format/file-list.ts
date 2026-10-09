import type { VibesOptions } from './vibes.js'
import { createStyle } from './style.js'

export interface FileCountEntry {
  file: string
  count: number
}

export function formatFileCountRows(
  entries: FileCountEntry[],
  unit: (count: number) => string,
  options: VibesOptions = {},
): string[] {
  if (entries.length === 0) return []

  const style = createStyle(options)
  const fileWidth = Math.max(...entries.map((e) => e.file.length))
  const countTexts = entries.map((e) => `${e.count} ${unit(e.count)}`)
  const countWidth = Math.max(...countTexts.map((t) => t.length))

  return entries.map((entry, i) => {
    const filePart = style.path(entry.file.padEnd(fileWidth))
    const countPart = style.value((countTexts[i] as string).padStart(countWidth))
    return `  ${filePart}  ${countPart}`
  })
}
