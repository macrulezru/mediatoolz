import { didYouMean } from '../../utils/closest.js'
import { ImageBatchUsageError } from './errors.js'

export const TEMPLATE_VARIABLES = [
  'name',
  'ext',
  'format',
  'dir',
  'width',
  'height',
  'size',
  'long',
  'short',
  'mp',
  'percent',
  'scale',
  'index',
  'hash',
  'date',
  'orig',
] as const
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]

const PARAMETERIZED: readonly TemplateVariable[] = ['index', 'hash']
const DEFAULT_HASH_LENGTH = 8
const MAX_HASH_LENGTH = 40
const MAX_INDEX_PADDING = 12
const FORBIDDEN_SEGMENT_CHARS = /[<>:"|?*]/

export type TemplateToken =
  { type: 'text'; text: string } | { type: 'var'; name: TemplateVariable; param?: number }

export interface TemplateValues {
  name: string
  ext: string
  format: string
  dir: string
  width: number
  height: number
  size: string
  long: number
  short: number
  mp: string
  percent: string
  scale: string
  index: number
  hash: string
  date: string
  orig: string
}

export interface DefaultTemplateShape {
  widths?: boolean
  heights?: boolean
  size?: boolean
  longEdge?: boolean
  shortEdge?: boolean
  megapixels?: boolean
  percent?: boolean
  scale?: boolean
}

export function defaultTemplate(shape: DefaultTemplateShape): string {
  if (shape.widths) return '{dir}/{name}-{width}w.{format}'
  if (shape.heights) return '{dir}/{name}-{height}h.{format}'
  if (shape.size) return '{dir}/{name}-{size}.{format}'
  if (shape.longEdge) return '{dir}/{name}-{long}l.{format}'
  if (shape.shortEdge) return '{dir}/{name}-{short}s.{format}'
  if (shape.megapixels) return '{dir}/{name}-{mp}mp.{format}'
  if (shape.percent) return '{dir}/{name}-{percent}pct.{format}'
  if (shape.scale) return '{dir}/{name}@{scale}x.{format}'
  return '{dir}/{name}.{format}'
}

export function parseTemplate(text: string, where: string): TemplateToken[] {
  if (text.trim() === '') {
    throw new ImageBatchUsageError(`${where}: the name template is empty`)
  }
  if (/^([\\/]|[A-Za-z]:)/.test(text)) {
    throw new ImageBatchUsageError(
      `${where}: the name template "${text}" is an absolute path — templates are always relative to the output folder`,
    )
  }
  const tokens: TemplateToken[] = []
  const pattern = /\{([a-zA-Z]+)(?::(\d+))?\}/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) tokens.push({ type: 'text', text: text.slice(last, match.index) })
    const name = match[1] as string
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      throw new ImageBatchUsageError(
        `${where}: unknown variable {${name}} in "${text}".${didYouMean(name, TEMPLATE_VARIABLES)} Available: ${TEMPLATE_VARIABLES.map((v) => `{${v}}`).join(' ')}`,
      )
    }
    const variable = name as TemplateVariable
    if (match[2] !== undefined) {
      if (!PARAMETERIZED.includes(variable)) {
        throw new ImageBatchUsageError(
          `${where}: {${variable}} takes no parameter (only ${PARAMETERIZED.map((v) => `{${v}:N}`).join(' and ')} do)`,
        )
      }
      const param = Number(match[2])
      const limit = variable === 'hash' ? MAX_HASH_LENGTH : MAX_INDEX_PADDING
      if (param < 1 || param > limit) {
        throw new ImageBatchUsageError(`${where}: {${variable}:${param}} must be 1–${limit}`)
      }
      tokens.push({ type: 'var', name: variable, param })
    } else {
      tokens.push({ type: 'var', name: variable })
    }
    last = match.index + match[0].length
  }
  if (last < text.length) tokens.push({ type: 'text', text: text.slice(last) })

  const literal = tokens
    .filter((t): t is { type: 'text'; text: string } => t.type === 'text')
    .map((t) => t.text)
    .join('')
  if (/[{}]/.test(literal)) {
    throw new ImageBatchUsageError(
      `${where}: unbalanced "{" or "}" in the name template "${text}" — write variables as {name}`,
    )
  }
  const shape = tokens.map((t) => (t.type === 'text' ? t.text : 'x')).join('')
  if (shape.split(/[\\/]/).includes('..')) {
    throw new ImageBatchUsageError(
      `${where}: the name template "${text}" must not contain ".." — results stay inside the output folder`,
    )
  }
  return tokens
}

export function templateUses(tokens: TemplateToken[], name: TemplateVariable): boolean {
  return tokens.some((token) => token.type === 'var' && token.name === name)
}

export function templateUsesAny(tokens: TemplateToken[], names: TemplateVariable[]): boolean {
  return names.some((name) => templateUses(tokens, name))
}

export function normalizeRelativePath(path: string, where: string): string {
  const segments: string[] = []
  for (const segment of path.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new ImageBatchUsageError(`${where}: "${path}" escapes the output folder`)
    }
    if (FORBIDDEN_SEGMENT_CHARS.test(segment) || [...segment].some((ch) => ch.charCodeAt(0) < 32)) {
      throw new ImageBatchUsageError(
        `${where}: "${segment}" contains a character that is not allowed in a file name`,
      )
    }
    segments.push(segment)
  }
  if (segments.length === 0) {
    throw new ImageBatchUsageError(`${where}: the name template produced an empty path`)
  }
  return segments.join('/')
}

export function expandTemplate(
  tokens: TemplateToken[],
  values: TemplateValues,
  where: string,
): string {
  const pieces = tokens.map((token) => {
    if (token.type === 'text') return token.text
    switch (token.name) {
      case 'index':
        return String(values.index).padStart(token.param ?? 1, '0')
      case 'hash':
        return values.hash.slice(0, token.param ?? DEFAULT_HASH_LENGTH)
      case 'width':
        return String(values.width)
      case 'height':
        return String(values.height)
      default:
        return String(values[token.name])
    }
  })
  return normalizeRelativePath(pieces.join(''), where)
}

export function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
