import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { splitList } from '../../utils/split-list.js'

export type HashType = 'hazehash' | 'blurhash' | 'thumbhash' | 'color' | 'preview'

export const ALL_TYPES: HashType[] = ['hazehash', 'blurhash', 'thumbhash', 'color', 'preview']

export const OUTPUT_FORMATS = ['json', 'plain', 'csv', 'ts', 'js'] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

export const DEFAULT_IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.tif',
  '.tiff',
]

export const DEFAULT_EXPORT_NAME = 'imageHashes'
export const DEFAULT_BLURHASH_COMPONENTS = { x: 4, y: 3 }
export const DEFAULT_HAZEHASH_BUDGET = 28
export const MIN_HAZEHASH_BUDGET = 7
export const MAX_HAZEHASH_BUDGET = 48
export const DEFAULT_SAMPLE_SIZE = 100
export const MAX_SAMPLE_SIZE = 100
export const DEFAULT_CACHE_FILE = '.mediatoolz-image-hash-cache.json'

export type Components = { x: number; y: number } | 'auto'

export class ImageHashUsageError extends Error {}

export interface HashEntry {
  file: string
  width: number
  height: number
  hazehash?: string
  blurhash?: string
  thumbhash?: string
  color?: string
  preview?: string
}

export interface OutputUnit {
  token: string
  content: string
}

export function parseTypes(value: string): HashType[] {
  const names = splitList(value).map((name) => name.toLowerCase())
  const selected = new Set<HashType>()
  for (const name of names) {
    if (name === 'both') {
      selected.add('blurhash')
      selected.add('thumbhash')
    } else if (name === 'all') {
      ALL_TYPES.forEach((type) => selected.add(type))
    } else if ((ALL_TYPES as string[]).includes(name)) {
      selected.add(name as HashType)
    } else {
      throw new ImageHashUsageError(
        `--type takes a comma-separated list of ${ALL_TYPES.join(', ')}, or both / all (got "${value}")`,
      )
    }
  }
  if (selected.size === 0) {
    throw new ImageHashUsageError(
      '--type needs at least one of hazehash, blurhash, thumbhash, color, preview',
    )
  }
  return ALL_TYPES.filter((type) => selected.has(type))
}

export function orderTypes(types: Iterable<HashType>): HashType[] {
  const set = new Set(types)
  return ALL_TYPES.filter((type) => set.has(type))
}

export function parseFormat(value: string): OutputFormat {
  const normalized = value.trim().toLowerCase()
  const found = OUTPUT_FORMATS.find((format) => format === normalized)
  if (!found) {
    throw new ImageHashUsageError(
      `--format must be one of ${OUTPUT_FORMATS.join(', ')} (got "${value}")`,
    )
  }
  return found
}

export function parseComponents(value: string): Components {
  if (value.trim().toLowerCase() === 'auto') return 'auto'
  const match = /^(\d+)x(\d+)$/i.exec(value.trim())
  const x = match ? Number(match[1]) : 0
  const y = match ? Number(match[2]) : 0
  if (!match || x < 1 || x > 9 || y < 1 || y > 9) {
    throw new ImageHashUsageError(
      `--components must look like 4x3 (each side from 1 to 9) or be "auto" (got "${value}")`,
    )
  }
  return { x, y }
}

export function resolveComponents(
  components: Components,
  width: number,
  height: number,
): { x: number; y: number } {
  if (components !== 'auto') return components
  const aspect = width >= height ? width / height : height / width
  const long = 4
  const short = Math.min(4, Math.max(2, Math.round(long / Math.sqrt(aspect))))
  return width >= height ? { x: long, y: short } : { x: short, y: long }
}

export function componentsLabel(components: Components): string {
  return components === 'auto' ? 'auto' : `${components.x}x${components.y}`
}

export function parseBudget(value: string): number {
  const budget = Number(value)
  if (!Number.isInteger(budget) || budget < MIN_HAZEHASH_BUDGET || budget > MAX_HAZEHASH_BUDGET) {
    throw new ImageHashUsageError(
      `--budget must be a whole number of bytes from ${MIN_HAZEHASH_BUDGET} to ${MAX_HAZEHASH_BUDGET} (got "${value}")`,
    )
  }
  return budget
}

export function parseSampleSize(value: string): number {
  const size = Number(value)
  if (!Number.isInteger(size) || size < 1 || size > MAX_SAMPLE_SIZE) {
    throw new ImageHashUsageError(
      `--size must be a whole number from 1 to ${MAX_SAMPLE_SIZE} (got "${value}")`,
    )
  }
  return size
}

export function parseMaxPixels(value: string): number {
  const pixels = Number(value)
  if (!Number.isInteger(pixels) || pixels < 0) {
    throw new ImageHashUsageError(
      `--max-pixels must be a whole number, 0 for no limit (got "${value}")`,
    )
  }
  return pixels
}

export function parseExtensions(value: string): string[] {
  return splitList(value).map((ext) => (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase())
}

export function withUpperCaseVariants(extensions: string[]): string[] {
  return [...new Set(extensions.flatMap((ext) => [ext, ext.toUpperCase()]))]
}

export function validateExportName(name: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    throw new ImageHashUsageError(`--name must be a valid identifier (got "${name}")`)
  }
  return name
}

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function splitPathArguments(
  args: string[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  const out: string[] = []
  for (const arg of args) {
    if (isUrl(arg) || exists(arg)) {
      out.push(arg)
      continue
    }
    if (arg.includes(',')) {
      for (const part of arg.split(',')) {
        const trimmed = part.trim()
        if (trimmed) out.push(trimmed)
      }
      continue
    }
    const words = arg.split(/\s+/).filter(Boolean)
    out.push(...(words.length > 1 && words.every((word) => exists(word)) ? words : [arg]))
  }
  return out
}

export function parseFileList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

export function defaultOutExtension(format: OutputFormat): string {
  return format === 'plain' ? '.txt' : `.${format}`
}

export function normalizeOutExtension(value: string | undefined, format: OutputFormat): string {
  if (value === undefined) return defaultOutExtension(format)
  const trimmed = value.trim()
  if (trimmed === '') return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

export function validateSuffix(
  suffix: string | undefined,
  types: HashType[],
  format: OutputFormat,
) {
  const resolved = suffix ?? '.{type}'
  if (format === 'plain' && types.length > 1 && !resolved.includes('{type}')) {
    throw new ImageHashUsageError(
      '--suffix must contain {type} when --format plain writes several hashes per image, ' +
        'otherwise the files would overwrite each other',
    )
  }
  return resolved
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function structured(entry: HashEntry, types: HashType[]): Record<string, string | number> {
  const out: Record<string, string | number> = { width: entry.width, height: entry.height }
  for (const type of types) {
    const value = entry[type]
    if (value !== undefined) out[type] = value
  }
  return out
}

function csvHeader(types: HashType[], withFile: boolean): string {
  return [...(withFile ? ['file'] : []), 'width', 'height', ...types].join(',')
}

function csvRow(entry: HashEntry, types: HashType[], withFile: boolean): string {
  return [
    ...(withFile ? [csvField(entry.file)] : []),
    String(entry.width),
    String(entry.height),
    ...types.map((type) => csvField(entry[type] ?? '')),
  ].join(',')
}

export function formatAggregate(
  entries: HashEntry[],
  types: HashType[],
  format: OutputFormat,
  exportName: string,
): string {
  if (format === 'csv') {
    return [csvHeader(types, true), ...entries.map((e) => csvRow(e, types, true))].join('\n') + '\n'
  }
  if (format === 'plain') {
    return (
      entries.map((e) => [e.file, ...types.map((type) => e[type] ?? '')].join('\t')).join('\n') +
      (entries.length > 0 ? '\n' : '')
    )
  }
  const map: Record<string, Record<string, string | number>> = {}
  for (const entry of entries) map[entry.file] = structured(entry, types)
  const json = JSON.stringify(map, null, 2)
  if (format === 'json') return `${json}\n`
  const suffix = format === 'ts' ? ' as const' : ''
  return `export const ${exportName} = ${json}${suffix}\n`
}

export function formatPerFile(
  entry: HashEntry,
  types: HashType[],
  format: OutputFormat,
): OutputUnit[] {
  if (format === 'plain') {
    return types.map((type) => ({ token: type, content: entry[type] ?? '' }))
  }
  const token = types.length > 1 ? 'hash' : (types[0] as HashType)
  const object = structured(entry, types)
  if (format === 'csv') {
    return [{ token, content: `${csvHeader(types, false)}\n${csvRow(entry, types, false)}\n` }]
  }
  const json = JSON.stringify(object, null, 2)
  if (format === 'json') return [{ token, content: `${json}\n` }]
  const suffix = format === 'ts' ? ' as const' : ''
  return [{ token, content: `export default ${json}${suffix}\n` }]
}

export function outputFileName(
  imagePath: string,
  suffix: string,
  token: string,
  extension: string,
): string {
  return `${basename(imagePath)}${suffix.replace(/\{type\}/g, token)}${extension}`
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        current += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields
}

function entryFromRecord(file: string, record: Record<string, unknown>): HashEntry {
  const entry: HashEntry = {
    file,
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
  }
  for (const type of ALL_TYPES) {
    const value = record[type]
    if (typeof value === 'string' && value !== '') entry[type] = value
  }
  return entry
}

export function parseAggregate(content: string, format: OutputFormat): HashEntry[] {
  const fail = (): never => {
    throw new ImageHashUsageError(
      'could not read the existing output file for --update; it must be a file this command ' +
        'generated (json, ts, js or csv), not reformatted by hand or by Prettier',
    )
  }
  if (format === 'plain') {
    throw new ImageHashUsageError('--update works with --format json, ts, js or csv, not plain')
  }
  if (format === 'csv') {
    const lines = content.split(/\r?\n/).filter((line) => line !== '')
    const header = parseCsvLine(lines[0] ?? '')
    if (header[0] !== 'file') return fail()
    return lines.slice(1).map((line) => {
      const fields = parseCsvLine(line)
      const record: Record<string, unknown> = {}
      header.forEach((name, i) => (record[name] = fields[i]))
      return entryFromRecord(fields[0] as string, record)
    })
  }
  let body = content.trim()
  if (format !== 'json') {
    const match = /^[^{]*(\{[\s\S]*\})\s*(?:as\s+const)?\s*;?\s*$/.exec(body)
    if (!match) return fail()
    body = match[1] as string
  }
  try {
    const parsed = JSON.parse(body) as Record<string, Record<string, unknown>>
    return Object.entries(parsed).map(([file, record]) => entryFromRecord(file, record))
  } catch {
    return fail()
  }
}
