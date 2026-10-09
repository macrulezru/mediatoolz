import { emptySharpen, type SharpenState, type SizeMethod } from './types'

export type Raw = Record<string, unknown>

export const SIZE_KEYS = [
  'widths',
  'heights',
  'size',
  'longEdge',
  'shortEdge',
  'megapixels',
  'percent',
] as const

const DEFAULT_VALUES: Record<Exclude<SizeMethod, 'original'>, unknown> = {
  widths: [800, 1600],
  heights: [600],
  size: '1920x1080',
  longEdge: [1600],
  shortEdge: [1080],
  megapixels: [2],
  percent: [50],
}

export function withKey(raw: Raw, key: string, value: unknown): Raw {
  const next = { ...raw }
  const empty =
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'number' && Number.isNaN(value))
  if (empty) delete next[key]
  else next[key] = value
  return next
}

export function sizeMethodOf(raw: Raw): SizeMethod {
  for (const key of SIZE_KEYS) if (raw[key] !== undefined) return key
  return 'original'
}

export function setSizeMethod(raw: Raw, method: SizeMethod): Raw {
  const next = { ...raw }
  for (const key of SIZE_KEYS) delete next[key]
  delete next.matchOrientation
  if (method !== 'original') next[method] = DEFAULT_VALUES[method]
  return next
}

export function valuesText(raw: Raw, method: SizeMethod): string {
  if (method === 'original') return ''
  const value = raw[method]
  return Array.isArray(value) ? value.join(', ') : String(value ?? '')
}

export function parseNumbers(text: string): number[] | undefined {
  const parts = text.split(/[,\s]+/).filter(Boolean)
  if (parts.length === 0) return []
  const numbers = parts.map(Number)
  return numbers.some((n) => !Number.isFinite(n)) ? undefined : numbers
}

export function sharpenToState(value: unknown): { state: SharpenState; lossy: boolean } {
  const state = emptySharpen()
  if (value === undefined || value === null) return { state, lossy: false }
  if (typeof value === 'string')
    return { state: { ...state, mode: 'preset', preset: value }, lossy: false }
  if (typeof value !== 'object' || Array.isArray(value)) return { state, lossy: true }
  const object = value as Raw
  if (typeof object.preset === 'string') {
    const others = Object.keys(object).filter((key) => key !== 'preset')
    if (others.length === 0)
      return { state: { ...state, mode: 'preset', preset: object.preset }, lossy: false }
    return { state: { ...state, mode: 'preset', preset: object.preset }, lossy: true }
  }
  const custom: SharpenState = { ...state, mode: 'custom' }
  if (typeof object.for === 'string') custom.for = object.for
  if (typeof object.amount === 'string') custom.amount = object.amount
  for (const key of ['radius', 'flat', 'jagged', 'threshold'] as const) {
    if (object[key] !== undefined) custom.fine[key] = String(object[key])
  }
  return { state: custom, lossy: false }
}

export function stateToSharpen(state: SharpenState): unknown {
  if (state.mode === 'none') return undefined
  if (state.mode === 'preset') return state.preset || undefined
  const result: Raw = { for: state.for, amount: state.amount }
  for (const [key, value] of Object.entries(state.fine)) {
    if (value.trim() !== '') result[key] = Number(value)
  }
  return result
}

export function starterConfig(): Raw {
  return {
    name: 'New config',
    outputs: [
      { id: 'responsive', widths: [400, 800, 1200], formats: ['webp', 'jpg'], quality: 'high' },
    ],
  }
}

export function starterRecipe(index: number): Raw {
  return { id: `recipe-${index}`, widths: [800], formats: ['webp'], quality: 'high' }
}
