import type { VibesOptions } from './vibes.js'
import { createStyle } from './style.js'

export interface TableColumn {
  header: string
  align?: 'left' | 'right'
  shrink?: boolean
  style?: (text: string) => string
}

const MIN_SHRUNK_WIDTH = 12

function shrinkLeft(text: string, width: number): string {
  if (text.length <= width) return text
  return `…${text.slice(text.length - (width - 1))}`
}

function fitWidths(widths: number[], columns: TableColumn[], available: number | null): number[] {
  if (available === null) return widths
  const chrome = widths.length * 3 + 1
  const total = widths.reduce((sum, w) => sum + w, 0) + chrome
  const shrinkIndex = columns.findIndex((c) => c.shrink)
  if (total <= available || shrinkIndex === -1) return widths
  const fitted = [...widths]
  const target = (widths[shrinkIndex] as number) - (total - available)
  fitted[shrinkIndex] = Math.max(MIN_SHRUNK_WIDTH, target)
  return fitted
}

export function renderTable(
  columns: TableColumn[],
  rows: string[][],
  options: VibesOptions = {},
  availableWidth: number | null = process.stdout.isTTY ? (process.stdout.columns ?? null) : null,
): string[] {
  const s = createStyle(options)
  const natural = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => (row[i] ?? '').length)),
  )
  const widths = fitWidths(natural, columns, availableWidth)

  const cell = (column: TableColumn, index: number, raw: string, header: boolean): string => {
    const width = widths[index] as number
    const text = column.shrink ? shrinkLeft(raw, width) : raw
    const padded = column.align === 'right' ? text.padStart(width) : text.padEnd(width)
    if (header) return s.bold(padded)
    return column.style ? column.style(padded) : padded
  }

  const rule = (left: string, mid: string, right: string): string =>
    s.muted(`${left}${widths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`)
  const bar = s.muted('│')
  const line = (texts: string[], header: boolean): string =>
    `${bar} ${columns.map((column, i) => cell(column, i, texts[i] ?? '', header)).join(` ${bar} `)} ${bar}`

  return [
    rule('┌', '┬', '┐'),
    line(
      columns.map((c) => c.header),
      true,
    ),
    rule('├', '┼', '┤'),
    ...rows.map((row) => line(row, false)),
    rule('└', '┴', '┘'),
  ]
}
