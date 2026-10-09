import { didYouMean } from '../../utils/closest.js'
import { ImageBatchUsageError } from './errors.js'

export const OUTPUT_FORMATS = ['jpg', 'png', 'webp', 'avif', 'gif', 'tiff', 'jp2', 'heif'] as const
export type OutputFormatName = (typeof OUTPUT_FORMATS)[number]
export type FormatChoice = OutputFormatName | 'original'

export const QUALITY_LEVELS = ['low', 'medium', 'high', 'best'] as const
export type QualityLevel = (typeof QUALITY_LEVELS)[number]
export type QualityValue = number | QualityLevel
export type QualityInput = QualityValue | Partial<Record<OutputFormatName, QualityValue>>

export type CodecValue = number | boolean | string
export type CodecOptions = Record<string, CodecValue>
export type CodecMap = Partial<Record<OutputFormatName, CodecOptions>>

interface OptionSpec {
  kind: 'quality' | 'int' | 'number' | 'bool' | 'enum' | 'enum-int'
  min?: number
  max?: number
  values?: readonly (string | number)[]
}

const quality = (min = 1): OptionSpec => ({ kind: 'quality', min, max: 100 })
const int = (min: number, max: number): OptionSpec => ({ kind: 'int', min, max })
const bool: OptionSpec = { kind: 'bool' }
const choice = (...values: string[]): OptionSpec => ({ kind: 'enum', values })
const subsampling = choice('4:2:0', '4:4:4')

export const CODEC_SPECS: Record<OutputFormatName, Record<string, OptionSpec>> = {
  jpg: {
    quality: quality(),
    mozjpeg: bool,
    progressive: bool,
    chromaSubsampling: subsampling,
  },
  png: {
    compressionLevel: int(0, 9),
    palette: bool,
    colors: int(2, 256),
    quality: quality(0),
    dither: { kind: 'number', min: 0, max: 1 },
    effort: int(1, 10),
    progressive: bool,
  },
  webp: {
    quality: quality(),
    lossless: bool,
    nearLossless: bool,
    alphaQuality: int(0, 100),
    effort: int(0, 6),
    smartSubsample: bool,
    preset: choice('default', 'photo', 'picture', 'drawing', 'icon', 'text'),
    minSize: bool,
  },
  avif: {
    quality: quality(),
    lossless: bool,
    effort: int(0, 9),
    chromaSubsampling: subsampling,
    bitdepth: { kind: 'enum-int', values: [8, 10, 12] },
    tune: choice('auto', 'iq', 'psnr', 'ssim'),
  },
  gif: {
    colors: int(2, 256),
    effort: int(1, 10),
    dither: { kind: 'number', min: 0, max: 1 },
    loop: int(0, 65535),
    delay: int(0, 65535),
    reuse: bool,
  },
  tiff: {
    compression: choice(
      'none',
      'jpeg',
      'deflate',
      'packbits',
      'ccittfax4',
      'lzw',
      'webp',
      'zstd',
      'jp2k',
    ),
    quality: quality(),
    predictor: choice('none', 'horizontal', 'float'),
    bitdepth: { kind: 'enum-int', values: [1, 2, 4, 8] },
    xres: { kind: 'number', min: 0.001, max: 1000000 },
    yres: { kind: 'number', min: 0.001, max: 1000000 },
  },
  jp2: {
    quality: quality(),
    lossless: bool,
    chromaSubsampling: subsampling,
  },
  heif: {
    quality: quality(),
    lossless: bool,
    effort: int(0, 9),
    compression: choice('av1', 'hevc'),
    chromaSubsampling: subsampling,
  },
}

const LEVEL_NUMBERS: Partial<Record<OutputFormatName, Record<QualityLevel, number>>> = {
  jpg: { low: 65, medium: 78, high: 85, best: 92 },
  webp: { low: 60, medium: 75, high: 82, best: 90 },
  avif: { low: 40, medium: 50, high: 60, best: 75 },
  heif: { low: 40, medium: 50, high: 60, best: 75 },
  jp2: { low: 60, medium: 75, high: 85, best: 92 },
  tiff: { low: 65, medium: 78, high: 85, best: 92 },
  png: { low: 40, medium: 60, high: 80, best: 95 },
}

export const BUILTIN_DEFAULTS: Record<OutputFormatName, CodecOptions> = {
  jpg: { quality: 82, mozjpeg: true, progressive: true },
  png: { compressionLevel: 9 },
  webp: { quality: 80, effort: 4 },
  avif: { quality: 55, effort: 4 },
  gif: {},
  tiff: {},
  jp2: {},
  heif: { compression: 'av1' },
}

const FORMAT_ALIASES: Record<string, FormatChoice> = {
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  tif: 'tiff',
  tiff: 'tiff',
  jp2: 'jp2',
  j2k: 'jp2',
  heif: 'heif',
  original: 'original',
}

export const FORMAT_EXTENSIONS: Record<OutputFormatName, string> = {
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  tiff: 'tiff',
  jp2: 'jp2',
  heif: 'heif',
}

export function normalizeFormat(raw: string, where = 'format'): FormatChoice {
  const found = FORMAT_ALIASES[raw.trim().toLowerCase()]
  if (found === undefined) {
    throw new ImageBatchUsageError(
      `${where}: unknown format "${raw}" — use ${[...OUTPUT_FORMATS, 'original'].join(', ')}.${didYouMean(raw, Object.keys(FORMAT_ALIASES))}`,
    )
  }
  return found
}

export function isQualityLevel(value: unknown): value is QualityLevel {
  return typeof value === 'string' && (QUALITY_LEVELS as readonly string[]).includes(value)
}

function formatsWithOption(option: string): OutputFormatName[] {
  return OUTPUT_FORMATS.filter((format) => option in CODEC_SPECS[format])
}

function coerce(spec: OptionSpec, raw: unknown, label: string): CodecValue {
  const fail = (expected: string): never => {
    throw new ImageBatchUsageError(`${label}: expected ${expected} (got ${JSON.stringify(raw)})`)
  }
  const asNumber = (): number => {
    if (typeof raw === 'number') return raw
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      return Number(raw)
    }
    return fail('a number')
  }
  switch (spec.kind) {
    case 'quality': {
      if (isQualityLevel(raw)) return raw
      if (typeof raw === 'string' && isQualityLevel(raw.trim())) return raw.trim()
      const n = asNumber()
      if (!Number.isInteger(n) || n < (spec.min ?? 1) || n > (spec.max ?? 100)) {
        return fail(
          `a whole number ${spec.min ?? 1}–${spec.max ?? 100} or ${QUALITY_LEVELS.join('/')}`,
        )
      }
      return n
    }
    case 'int': {
      const n = asNumber()
      if (!Number.isInteger(n) || n < (spec.min as number) || n > (spec.max as number)) {
        return fail(`a whole number ${spec.min}–${spec.max}`)
      }
      return n
    }
    case 'number': {
      const n = asNumber()
      if (n < (spec.min as number) || n > (spec.max as number)) {
        return fail(`a number ${spec.min}–${spec.max}`)
      }
      return n
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw
      if (raw === 'true' || raw === '1' || raw === 'yes') return true
      if (raw === 'false' || raw === '0' || raw === 'no') return false
      return fail('true or false')
    }
    case 'enum': {
      const text = String(raw)
      if (!(spec.values as readonly string[]).includes(text)) {
        return fail(`one of ${(spec.values as readonly string[]).join(', ')}`)
      }
      return text
    }
    case 'enum-int': {
      const n = asNumber()
      if (!(spec.values as readonly number[]).includes(n)) {
        return fail(`one of ${(spec.values as readonly number[]).join(', ')}`)
      }
      return n
    }
  }
  return fail('a valid value')
}

export function validateCodecOptions(
  format: OutputFormatName,
  options: Record<string, unknown>,
  where: string,
): CodecOptions {
  const specs = CODEC_SPECS[format]
  const result: CodecOptions = {}
  for (const [name, raw] of Object.entries(options)) {
    const spec = specs[name]
    if (spec === undefined) {
      const elsewhere = formatsWithOption(name)
      if (elsewhere.length > 0) {
        throw new ImageBatchUsageError(
          `${where}: "${name}" is not an option of ${format} (it works with ${elsewhere.join(', ')}). ${format} options: ${Object.keys(specs).join(', ') || 'none'}.`,
        )
      }
      throw new ImageBatchUsageError(
        `${where}: unknown ${format} option "${name}".${didYouMean(name, Object.keys(specs))} ${format} options: ${Object.keys(specs).join(', ') || 'none'}.`,
      )
    }
    result[name] = coerce(spec, raw, `${where}: ${format}.${name}`)
  }
  return result
}

export function validateCodecMap(map: unknown, where: string): CodecMap {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new ImageBatchUsageError(`${where}: expected an object of format → options`)
  }
  const result: CodecMap = {}
  for (const [rawFormat, options] of Object.entries(map)) {
    const format = normalizeFormat(rawFormat, where)
    if (format === 'original') {
      throw new ImageBatchUsageError(`${where}: "original" has no options of its own`)
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ImageBatchUsageError(`${where}: ${rawFormat} must be an object of options`)
    }
    result[format] = {
      ...result[format],
      ...validateCodecOptions(format, options as Record<string, unknown>, `${where}.${rawFormat}`),
    }
  }
  return result
}

export function validateQualityInput(input: unknown, where: string): QualityInput {
  if (typeof input === 'number' || isQualityLevel(input)) {
    return coerce(CODEC_SPECS.jpg.quality as OptionSpec, input, where) as QualityValue
  }
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const result: Partial<Record<OutputFormatName, QualityValue>> = {}
    for (const [rawFormat, value] of Object.entries(input)) {
      const format = normalizeFormat(rawFormat, where)
      if (format === 'original') {
        throw new ImageBatchUsageError(`${where}: "original" has no quality of its own`)
      }
      const spec = CODEC_SPECS[format].quality
      if (spec === undefined) {
        throw new ImageBatchUsageError(`${where}: ${format} has no quality option`)
      }
      result[format] = coerce(spec, value, `${where}.${rawFormat}`) as QualityValue
    }
    return result
  }
  throw new ImageBatchUsageError(
    `${where}: expected a number 1–100, ${QUALITY_LEVELS.join('/')}, or an object of format → quality`,
  )
}

export function parseQualityArg(text: string): QualityInput {
  const trimmed = text.trim()
  if (!trimmed.includes('=')) {
    return validateQualityInput(/^\d+$/.test(trimmed) ? Number(trimmed) : trimmed, '--quality')
  }
  const map: Record<string, string> = {}
  for (const part of trimmed.split(',')) {
    const [key, value] = part.split('=')
    if (key === undefined || value === undefined || key.trim() === '' || value.trim() === '') {
      throw new ImageBatchUsageError(
        `--quality: expected "format=value" pairs, e.g. jpg=82,webp=high (got "${part}")`,
      )
    }
    map[key.trim()] = value.trim()
  }
  const converted: Record<string, number | string> = {}
  for (const [key, value] of Object.entries(map)) {
    converted[key] = /^\d+$/.test(value) ? Number(value) : value
  }
  return validateQualityInput(converted, '--quality')
}

export function parseCodecArgs(args: string[]): CodecMap {
  const grouped: Partial<Record<OutputFormatName, Record<string, string>>> = {}
  for (const arg of args) {
    const match = /^([a-z0-9]+)\.([A-Za-z]+)=(.*)$/.exec(arg)
    if (!match) {
      throw new ImageBatchUsageError(
        `--codec: expected "format.option=value", e.g. jpg.mozjpeg=true (got "${arg}")`,
      )
    }
    const format = normalizeFormat(match[1] as string, '--codec')
    if (format === 'original') {
      throw new ImageBatchUsageError(`--codec: "original" has no options of its own`)
    }
    grouped[format] = { ...grouped[format], [match[2] as string]: match[3] as string }
  }
  const result: CodecMap = {}
  for (const format of OUTPUT_FORMATS) {
    const options = grouped[format]
    if (options) result[format] = validateCodecOptions(format, options, '--codec')
  }
  return result
}

export interface CodecLayer {
  codecs?: CodecMap
  quality?: QualityInput
}

function shortcutFor(input: QualityInput, format: OutputFormatName): QualityValue | undefined {
  if (typeof input === 'number' || isQualityLevel(input)) return input
  return input[format]
}

export function resolveCodecOptions(format: OutputFormatName, layers: CodecLayer[]): CodecOptions {
  const options: CodecOptions = { ...BUILTIN_DEFAULTS[format] }
  const supportsQuality = 'quality' in CODEC_SPECS[format]
  for (const layer of layers) {
    if (layer.quality !== undefined && supportsQuality) {
      const value = shortcutFor(layer.quality, format)
      if (value !== undefined) options.quality = value
    }
    const own = layer.codecs?.[format]
    if (own) Object.assign(options, own)
  }
  if (format === 'png' && options.palette !== true) delete options.quality
  if (typeof options.quality === 'string') {
    const table = LEVEL_NUMBERS[format]
    const level = options.quality as QualityLevel
    options.quality = table ? table[level] : (BUILTIN_DEFAULTS[format].quality ?? 80)
  }
  return options
}

const SHARP_FORMAT_KEYS: Record<OutputFormatName, string> = {
  jpg: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'heif',
  gif: 'gif',
  tiff: 'tiff',
  jp2: 'jp2k',
  heif: 'heif',
}

export function unsupportedFormats(
  sharp: unknown,
  formats: Iterable<OutputFormatName>,
): OutputFormatName[] {
  const table = (
    sharp as { format?: Record<string, { output?: { buffer?: boolean } } | undefined> }
  ).format
  if (!table) return []
  const missing: OutputFormatName[] = []
  for (const format of new Set(formats)) {
    if (table[SHARP_FORMAT_KEYS[format]]?.output?.buffer !== true) missing.push(format)
  }
  return missing
}

export function supportsQualityLimit(format: OutputFormatName, codec: CodecOptions): boolean {
  if (format === 'jpg' || format === 'webp' || format === 'avif' || format === 'heif') return true
  if (format === 'jp2') return true
  return format === 'png' && codec.palette === true
}

export function qualityOf(format: OutputFormatName, codec: CodecOptions): number {
  const own = codec.quality
  if (typeof own === 'number') return own
  const fallback: Partial<Record<OutputFormatName, number>> = { heif: 50, jp2: 80, png: 100 }
  return fallback[format] ?? 80
}

export function sharpFormatName(format: OutputFormatName): string {
  return format === 'jpg' ? 'jpeg' : format
}

export function toSharpOptions(options: CodecOptions): Record<string, CodecValue> {
  const mapped: Record<string, CodecValue> = {}
  for (const [name, value] of Object.entries(options)) {
    mapped[name === 'colors' ? 'colours' : name] = value
  }
  return mapped
}

export function describeOptions(options: CodecOptions): string {
  const parts = Object.entries(options).map(([name, value]) => `${name}=${String(value)}`)
  return parts.join(' ')
}
