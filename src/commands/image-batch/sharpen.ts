import type { Command } from 'commander'
import { ImageBatchUsageError } from './errors.js'

export const SHARPEN_TARGETS = ['screen', 'matte', 'glossy'] as const
export const SHARPEN_AMOUNTS = ['low', 'standard', 'high'] as const
export const SHARPEN_FINE_KEYS = ['radius', 'flat', 'jagged', 'threshold'] as const

export type SharpenTarget = (typeof SHARPEN_TARGETS)[number]
export type SharpenAmount = (typeof SHARPEN_AMOUNTS)[number]
export type SharpenFineKey = (typeof SHARPEN_FINE_KEYS)[number]

export interface SharpenFields {
  for?: SharpenTarget
  amount?: SharpenAmount
  radius?: number
  flat?: number
  jagged?: number
  threshold?: number
}

export interface SharpenLayer extends SharpenFields {
  preset?: string
}

export interface SharpenSpec extends SharpenFields {
  for: SharpenTarget
  amount: SharpenAmount
}

export interface SharpenParams {
  sigma: number
  m1: number
  m2: number
  x1?: number
}

export const SHARPEN_RANGES: Record<SharpenFineKey, readonly [number, number]> = {
  radius: [0.000001, 10],
  flat: [0, 1_000_000],
  jagged: [0, 1_000_000],
  threshold: [0, 1_000_000],
}

const RADIUS: Record<SharpenTarget, number> = { screen: 0.6, matte: 1, glossy: 1.4 }
const STRENGTH: Record<SharpenAmount, { m1: number; m2: number }> = {
  low: { m1: 0.5, m2: 1.5 },
  standard: { m1: 1, m2: 3 },
  high: { m1: 1.8, m2: 5 },
}

const LAYER_KEYS = ['preset', 'for', 'amount', ...SHARPEN_FINE_KEYS] as const
const FIELD_KEYS = LAYER_KEYS.filter((key) => key !== 'preset')

export function completeSharpen(fields: SharpenFields): SharpenSpec {
  return { ...fields, for: fields.for ?? 'screen', amount: fields.amount ?? 'standard' }
}

export function sharpenParams(spec: SharpenSpec): SharpenParams {
  const strength = STRENGTH[spec.amount]
  return {
    sigma: spec.radius ?? RADIUS[spec.for],
    m1: spec.flat ?? strength.m1,
    m2: spec.jagged ?? strength.m2,
    ...(spec.threshold !== undefined ? { x1: spec.threshold } : {}),
  }
}

export function describeSharpen(fields: SharpenLayer): string {
  const parts: string[] = []
  if (fields.preset !== undefined) parts.push(fields.preset)
  if (fields.for !== undefined) parts.push(`for ${fields.for}`)
  if (fields.amount !== undefined) parts.push(fields.amount)
  for (const key of SHARPEN_FINE_KEYS) {
    if (fields[key] !== undefined) parts.push(`${key} ${fields[key]}`)
  }
  return parts.join(', ')
}

function rangeText(key: SharpenFineKey): string {
  const [min, max] = SHARPEN_RANGES[key]
  return `${min} to ${max}`
}

function checkFine(key: SharpenFineKey, value: unknown, where: string): number {
  const [min, max] = SHARPEN_RANGES[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ImageBatchUsageError(`${where}: expected a number from ${rangeText(key)}`)
  }
  return value
}

export function parseSharpenFields(
  object: Record<string, unknown>,
  at: string,
  allowPreset: boolean,
): SharpenLayer {
  const allowed: readonly string[] = allowPreset ? LAYER_KEYS : FIELD_KEYS
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new ImageBatchUsageError(`${at}: unknown key "${key}" — expected ${allowed.join(', ')}`)
    }
  }
  const layer: SharpenLayer = {}
  if (object.preset !== undefined) {
    if (typeof object.preset !== 'string' || object.preset === '') {
      throw new ImageBatchUsageError(`${at}.preset: expected the name of a sharpen preset`)
    }
    layer.preset = object.preset
  }
  if (object.for !== undefined) {
    if (!(SHARPEN_TARGETS as readonly unknown[]).includes(object.for)) {
      throw new ImageBatchUsageError(`${at}.for: expected one of ${SHARPEN_TARGETS.join(', ')}`)
    }
    layer.for = object.for as SharpenTarget
  }
  if (object.amount !== undefined) {
    if (!(SHARPEN_AMOUNTS as readonly unknown[]).includes(object.amount)) {
      throw new ImageBatchUsageError(`${at}.amount: expected one of ${SHARPEN_AMOUNTS.join(', ')}`)
    }
    layer.amount = object.amount as SharpenAmount
  }
  for (const key of SHARPEN_FINE_KEYS) {
    if (object[key] !== undefined) layer[key] = checkFine(key, object[key], `${at}.${key}`)
  }
  if (Object.keys(layer).length === 0) {
    throw new ImageBatchUsageError(`${at}: expected at least one of ${allowed.join(', ')}`)
  }
  return layer
}

export function parseSharpenLayer(value: unknown, at: string): SharpenLayer {
  if (typeof value === 'string') {
    return parseSharpenFields({ preset: value }, at, true)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ImageBatchUsageError(
      `${at}: expected a preset name or an object with ${LAYER_KEYS.join(', ')}`,
    )
  }
  return parseSharpenFields(value as Record<string, unknown>, at, true)
}

export function expandSharpen(
  layer: SharpenLayer,
  presets: Record<string, SharpenFields> | undefined,
  at: string,
): SharpenFields {
  const { preset, ...own } = layer
  if (preset === undefined) return own
  const base = presets?.[preset]
  if (!base) {
    throw new ImageBatchUsageError(
      `${at}: the sharpen preset "${preset}" is not loaded — see \`mediatoolz image-batch sharpen list\``,
    )
  }
  return { ...base, ...own }
}

export interface SharpenFlagOptions {
  sharpen?: string
  sharpenFor?: string
  sharpenAmount?: string
  sharpenRadius?: string
  sharpenFlat?: string
  sharpenJagged?: string
  sharpenThreshold?: string
}

const FLAG_FINE: [SharpenFineKey, keyof SharpenFlagOptions][] = [
  ['radius', 'sharpenRadius'],
  ['flat', 'sharpenFlat'],
  ['jagged', 'sharpenJagged'],
  ['threshold', 'sharpenThreshold'],
]

export function parseSharpenFlags(options: SharpenFlagOptions): SharpenLayer | undefined {
  const raw: Record<string, unknown> = {}
  if (options.sharpen !== undefined) raw.preset = options.sharpen
  if (options.sharpenFor !== undefined) raw.for = options.sharpenFor
  if (options.sharpenAmount !== undefined) raw.amount = options.sharpenAmount
  for (const [key, flag] of FLAG_FINE) {
    const text = options[flag]
    if (text === undefined) continue
    const number = Number(text)
    if (text.trim() === '' || !Number.isFinite(number)) {
      throw new ImageBatchUsageError(`--sharpen-${key} must be a number from ${rangeText(key)}`)
    }
    raw[key] = number
  }
  if (Object.keys(raw).length === 0) return undefined
  try {
    return parseSharpenFields(raw, 'sharpen', true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ImageBatchUsageError(
      message
        .replace(/^sharpen\.for/, '--sharpen-for')
        .replace(/^sharpen\.amount/, '--sharpen-amount')
        .replace(/^sharpen\.(radius|flat|jagged|threshold)/, '--sharpen-$1'),
    )
  }
}

export function addSharpenFlags(command: Command, withPreset = true): Command {
  if (withPreset) {
    command.option('--sharpen <preset>', 'sharpen with a saved preset (see the sharpen command)')
  }
  return command
    .option('--sharpen-for <target>', 'sharpen the result for: screen, matte or glossy')
    .option('--sharpen-amount <amount>', 'sharpening amount: low, standard or high')
    .option('--sharpen-radius <sigma>', 'sharpening radius (sigma), 0.000001 to 10')
    .option('--sharpen-flat <n>', 'sharpening strength on flat areas, 0 to 1000000')
    .option('--sharpen-jagged <n>', 'sharpening strength on sharp edges, 0 to 1000000')
    .option(
      '--sharpen-threshold <n>',
      'edge threshold that separates flat from jagged, 0 to 1000000',
    )
}
