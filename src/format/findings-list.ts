import type { VibesOptions } from './vibes.js'
import { createStyle } from './style.js'

export interface FindingRow {
  location: string
  name: string
  tag: string
}

export function formatFindingsRows(entries: FindingRow[], options: VibesOptions = {}): string[] {
  if (entries.length === 0) return []

  const style = createStyle(options)
  const locationWidth = Math.max(...entries.map((e) => e.location.length))
  const nameWidth = Math.max(...entries.map((e) => e.name.length))

  return entries.map((entry) => {
    const locationPart = style.location(entry.location.padEnd(locationWidth))
    const namePart = style.name(entry.name.padEnd(nameWidth))
    return `  ${locationPart}  ${namePart}  ${style.tag(entry.tag)}`.trimEnd()
  })
}
