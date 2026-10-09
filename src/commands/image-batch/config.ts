import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { didYouMean } from '../../utils/closest.js'
import {
  ALL_TYPES,
  MAX_HAZEHASH_BUDGET,
  MIN_HAZEHASH_BUDGET,
  type HashType,
} from '../image-hash/core.js'
import {
  normalizeFormat,
  validateCodecMap,
  validateQualityInput,
  type CodecLayer,
  type CodecMap,
  type FormatChoice,
  type QualityInput,
} from './codecs.js'
import { ImageBatchUsageError } from './errors.js'
import { FIT_MODES, parseSize, type Box, type Fit } from './geometry.js'
import {
  completeSharpen,
  expandSharpen,
  parseSharpenLayer,
  type SharpenFields,
  type SharpenLayer,
  type SharpenSpec,
} from './sharpen.js'
import { defaultTemplate, parseTemplate, type TemplateToken } from './template.js'

export const CONFIG_EXTENSIONS = ['.json', '.js', '.mjs', '.ts'] as const
export const CONFIG_DIR_SEGMENTS = ['.mediatoolz', 'image-batch'] as const

export const METADATA_MODES = ['strip', 'keep', 'keep-icc'] as const
export type MetadataMode = (typeof METADATA_MODES)[number]

export const POSITIONS = [
  'centre',
  'center',
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
  'top',
  'right top',
  'right',
  'right bottom',
  'bottom',
  'left bottom',
  'left',
  'left top',
  'entropy',
  'attention',
] as const

const RECIPE_KEYS = [
  'id',
  'preset',
  'widths',
  'heights',
  'size',
  'longEdge',
  'shortEdge',
  'megapixels',
  'percent',
  'scale',
  'matchOrientation',
  'maxBytes',
  'formats',
  'quality',
  'codecs',
  'fit',
  'position',
  'background',
  'withoutEnlargement',
  'name',
  'autoOrient',
  'metadata',
  'rotate',
  'flip',
  'flop',
  'grayscale',
  'sharpen',
  'blur',
  'flatten',
] as const

const PRESET_KEYS = [...RECIPE_KEYS.filter((key) => key !== 'preset' && key !== 'id'), 'extends']
const DEFAULT_KEYS = RECIPE_KEYS.filter((key) => key !== 'preset' && key !== 'id')
const CONFIG_KEYS = [
  '$schema',
  'name',
  'description',
  'defaults',
  'presets',
  'outputs',
  'match',
  'placeholders',
] as const
const PLACEHOLDER_KEYS = ['hazehash', 'blurhash', 'thumbhash', 'color', 'preview'] as const
const FLAG_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([^)]*\))$/

export interface RecipeLayer extends CodecLayer {
  id?: string
  preset?: string
  extends?: string
  widths?: number[]
  heights?: number[]
  size?: Required<Box>
  longEdge?: number[]
  shortEdge?: number[]
  megapixels?: number[]
  percent?: number[]
  scale?: number[]
  matchOrientation?: boolean
  noResize?: boolean
  maxBytes?: number
  formats?: FormatChoice[]
  fit?: Fit
  position?: string
  background?: string
  withoutEnlargement?: boolean
  template?: { text: string; tokens: TemplateToken[] }
  autoOrient?: boolean
  metadata?: MetadataMode
  rotate?: number
  flip?: boolean
  flop?: boolean
  grayscale?: boolean
  sharpen?: SharpenLayer
  blur?: number
  flatten?: string | true
}

export interface MatchRule {
  glob: string
  outputs: RecipeLayer[]
}

export interface PlaceholderSettings {
  types: HashType[]
  budget?: number
  components?: string
}

export interface BatchConfig {
  title?: string
  description?: string
  defaults: RecipeLayer
  presets: Record<string, RecipeLayer>
  outputs: RecipeLayer[]
  match: MatchRule[]
  placeholders?: PlaceholderSettings
  sharpenPresets?: Record<string, SharpenFields>
}

export interface ResolvedRecipe {
  id?: string
  widths: number[]
  heights: number[]
  size?: Required<Box>
  longEdge: number[]
  shortEdge: number[]
  megapixels: number[]
  percent: number[]
  scales: number[]
  matchOrientation: boolean
  maxBytes?: number
  explicitTemplate: boolean
  formats: FormatChoice[]
  layers: CodecLayer[]
  fit: Fit
  position?: string
  background?: string
  withoutEnlargement: boolean
  template: { text: string; tokens: TemplateToken[] }
  autoOrient: boolean
  metadata: MetadataMode
  rotate?: number
  flip: boolean
  flop: boolean
  grayscale: boolean
  sharpen?: SharpenSpec
  blur?: number
  flatten?: string | true
}

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function expectObject(value: unknown, where: string): Obj {
  if (!isObject(value)) throw new ImageBatchUsageError(`${where}: expected an object`)
  return value
}

function checkKeys(object: Obj, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new ImageBatchUsageError(
        `${where}: unknown key "${key}".${didYouMean(key, allowed)} Allowed: ${allowed.join(', ')}.`,
      )
    }
  }
}

function numberList(value: unknown, where: string, min: number, max: number): number[] {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new ImageBatchUsageError(`${where}: the list is empty`)
  return list.map((item) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < min || item > max) {
      throw new ImageBatchUsageError(
        `${where}: expected whole numbers ${min}–${max} (got ${JSON.stringify(item)})`,
      )
    }
    return item
  })
}

function scaleList(value: unknown, where: string): number[] {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new ImageBatchUsageError(`${where}: the list is empty`)
  return list.map((item) => {
    if (typeof item !== 'number' || !(item > 0) || item > 16) {
      throw new ImageBatchUsageError(
        `${where}: expected numbers above 0 and up to 16 (got ${JSON.stringify(item)})`,
      )
    }
    return item
  })
}

function decimalList(value: unknown, where: string, min: number, max: number): number[] {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) throw new ImageBatchUsageError(`${where}: the list is empty`)
  return list.map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max) {
      throw new ImageBatchUsageError(
        `${where}: expected numbers from ${min} to ${max} (got ${JSON.stringify(item)})`,
      )
    }
    return item
  })
}

const BYTE_UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
}
const MIN_MAX_BYTES = 1024

export function parseByteSize(value: unknown, where: string): number {
  let bytes = Number.NaN
  if (typeof value === 'number') bytes = value
  else if (typeof value === 'string') {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(value)
    const unit = match ? BYTE_UNITS[(match[2] as string).toLowerCase()] : undefined
    if (match && unit !== undefined) bytes = Math.round(Number(match[1]) * unit)
  }
  if (!Number.isFinite(bytes) || bytes < MIN_MAX_BYTES) {
    throw new ImageBatchUsageError(
      `${where}: expected a size of at least 1 KB such as "200KB", "1.5MB" or a number of bytes (got ${JSON.stringify(value)})`,
    )
  }
  return bytes
}

function expectBool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new ImageBatchUsageError(`${where}: expected true or false`)
  return value
}

function expectColor(value: unknown, where: string): string {
  if (typeof value !== 'string' || !FLAG_COLOR.test(value.trim())) {
    throw new ImageBatchUsageError(
      `${where}: expected a color like #ffffff, white or rgba(0,0,0,0) (got ${JSON.stringify(value)})`,
    )
  }
  return value.trim()
}

function parseFormats(
  value: unknown,
  where: string,
): { formats: FormatChoice[]; codecs?: CodecMap } {
  if (typeof value === 'string') return { formats: [normalizeFormat(value, where)] }
  if (Array.isArray(value)) {
    if (value.length === 0) throw new ImageBatchUsageError(`${where}: the list is empty`)
    return {
      formats: value.map((item) => {
        if (typeof item !== 'string') {
          throw new ImageBatchUsageError(
            `${where}: expected format names (got ${JSON.stringify(item)})`,
          )
        }
        return normalizeFormat(item, where)
      }),
    }
  }
  if (isObject(value)) {
    const codecs = validateCodecMap(value, where)
    const formats = Object.keys(value).map((key) => normalizeFormat(key, where))
    if (formats.length === 0) throw new ImageBatchUsageError(`${where}: the map is empty`)
    return { formats, codecs }
  }
  throw new ImageBatchUsageError(
    `${where}: expected a format name, a list or a map of format → options`,
  )
}

function mergeCodecMaps(...maps: (CodecMap | undefined)[]): CodecMap | undefined {
  const result: CodecMap = {}
  let any = false
  for (const map of maps) {
    if (!map) continue
    for (const [format, options] of Object.entries(map)) {
      any = true
      const key = format as keyof CodecMap
      result[key] = { ...result[key], ...options }
    }
  }
  return any ? result : undefined
}

export function parseRecipeLayer(
  raw: unknown,
  where: string,
  allowed: readonly string[],
): RecipeLayer {
  const object = expectObject(raw, where)
  checkKeys(object, allowed, where)
  const layer: RecipeLayer = {}
  let formatCodecs: CodecMap | undefined

  for (const [key, value] of Object.entries(object)) {
    const at = `${where}.${key}`
    switch (key) {
      case 'id':
      case 'preset':
      case 'extends':
        if (typeof value !== 'string' || value.trim() === '') {
          throw new ImageBatchUsageError(`${at}: expected a non-empty string`)
        }
        layer[key] = value
        break
      case 'widths':
        layer.widths = numberList(value, at, 1, 65535)
        break
      case 'heights':
        layer.heights = numberList(value, at, 1, 65535)
        break
      case 'longEdge':
        layer.longEdge = numberList(value, at, 1, 65535)
        break
      case 'shortEdge':
        layer.shortEdge = numberList(value, at, 1, 65535)
        break
      case 'megapixels':
        layer.megapixels = decimalList(value, at, 0.001, 1000)
        break
      case 'percent':
        layer.percent = decimalList(value, at, 0.1, 1000)
        break
      case 'maxBytes':
        layer.maxBytes = parseByteSize(value, at)
        break
      case 'size':
        if (typeof value !== 'string') throw new ImageBatchUsageError(`${at}: expected "WxH"`)
        layer.size = parseSize(value, at)
        break
      case 'scale':
        layer.scale = scaleList(value, at)
        break
      case 'formats': {
        const parsed = parseFormats(value, at)
        layer.formats = parsed.formats
        formatCodecs = parsed.codecs
        break
      }
      case 'quality':
        layer.quality = validateQualityInput(value, at)
        break
      case 'codecs':
        layer.codecs = validateCodecMap(value, at)
        break
      case 'fit':
        if (typeof value !== 'string' || !(FIT_MODES as readonly string[]).includes(value)) {
          throw new ImageBatchUsageError(`${at}: expected one of ${FIT_MODES.join(', ')}`)
        }
        layer.fit = value as Fit
        break
      case 'position':
        if (typeof value !== 'string' || !(POSITIONS as readonly string[]).includes(value)) {
          throw new ImageBatchUsageError(`${at}: expected one of ${POSITIONS.join(', ')}`)
        }
        layer.position = value
        break
      case 'background':
        layer.background = expectColor(value, at)
        break
      case 'withoutEnlargement':
      case 'matchOrientation':
      case 'autoOrient':
      case 'flip':
      case 'flop':
      case 'grayscale':
        layer[key] = expectBool(value, at)
        break
      case 'name':
        if (typeof value !== 'string')
          throw new ImageBatchUsageError(`${at}: expected a template string`)
        layer.template = { text: value, tokens: parseTemplate(value, at) }
        break
      case 'metadata':
        if (typeof value !== 'string' || !(METADATA_MODES as readonly string[]).includes(value)) {
          throw new ImageBatchUsageError(`${at}: expected one of ${METADATA_MODES.join(', ')}`)
        }
        layer.metadata = value as MetadataMode
        break
      case 'rotate':
        if (value !== 0 && value !== 90 && value !== 180 && value !== 270) {
          throw new ImageBatchUsageError(`${at}: expected 0, 90, 180 or 270`)
        }
        layer.rotate = value
        break
      case 'sharpen':
        layer.sharpen = parseSharpenLayer(value, at)
        break
      case 'blur':
        if (typeof value !== 'number' || !(value >= 0.3) || value > 1000) {
          throw new ImageBatchUsageError(`${at}: expected a sigma from 0.3 to 1000`)
        }
        layer.blur = value
        break
      case 'flatten':
        if (value === true) layer.flatten = true
        else if (value !== false) layer.flatten = expectColor(value, at)
        break
    }
  }

  const merged = mergeCodecMaps(formatCodecs, layer.codecs)
  if (merged) layer.codecs = merged
  return layer
}

function parsePlaceholders(raw: unknown, where: string): PlaceholderSettings {
  const object = expectObject(raw, where)
  checkKeys(object, PLACEHOLDER_KEYS, where)
  const types: HashType[] = []
  const settings: PlaceholderSettings = { types }
  for (const type of ALL_TYPES) {
    const value = object[type]
    if (value === undefined || value === false) continue
    types.push(type)
    if (value === true) continue
    const options = expectObject(value, `${where}.${type}`)
    if (type === 'hazehash') {
      checkKeys(options, ['budget'], `${where}.hazehash`)
      if (options.budget !== undefined) {
        const budget = options.budget
        if (
          typeof budget !== 'number' ||
          !Number.isInteger(budget) ||
          budget < MIN_HAZEHASH_BUDGET ||
          budget > MAX_HAZEHASH_BUDGET
        ) {
          throw new ImageBatchUsageError(
            `${where}.hazehash.budget: expected a whole number of bytes ${MIN_HAZEHASH_BUDGET}–${MAX_HAZEHASH_BUDGET}`,
          )
        }
        settings.budget = budget
      }
    } else if (type === 'blurhash') {
      checkKeys(options, ['components'], `${where}.blurhash`)
      if (options.components !== undefined) {
        const components = options.components
        if (typeof components !== 'string' || !/^(auto|[1-9]x[1-9])$/i.test(components)) {
          throw new ImageBatchUsageError(
            `${where}.blurhash.components: expected "auto" or a value like "4x3"`,
          )
        }
        settings.components = components
      }
    } else {
      checkKeys(options, [], `${where}.${type}`)
    }
  }
  return settings
}

export function parseConfig(raw: unknown, where = 'config'): BatchConfig {
  const object = expectObject(raw, where)
  checkKeys(object, CONFIG_KEYS, where)

  const config: BatchConfig = { defaults: {}, presets: {}, outputs: [], match: [] }
  if (object.name !== undefined) {
    if (typeof object.name !== 'string')
      throw new ImageBatchUsageError(`${where}.name: expected a string`)
    config.title = object.name
  }
  if (object.description !== undefined) {
    if (typeof object.description !== 'string') {
      throw new ImageBatchUsageError(`${where}.description: expected a string`)
    }
    config.description = object.description
  }
  if (object.defaults !== undefined) {
    config.defaults = parseRecipeLayer(object.defaults, `${where}.defaults`, DEFAULT_KEYS)
  }
  if (object.presets !== undefined) {
    for (const [name, value] of Object.entries(expectObject(object.presets, `${where}.presets`))) {
      config.presets[name] = parseRecipeLayer(value, `${where}.presets.${name}`, PRESET_KEYS)
    }
  }
  if (object.outputs !== undefined) {
    if (!Array.isArray(object.outputs)) {
      throw new ImageBatchUsageError(`${where}.outputs: expected a list of recipes`)
    }
    config.outputs = object.outputs.map((item, i) =>
      parseRecipeLayer(item, `${where}.outputs[${i}]`, RECIPE_KEYS),
    )
  }
  if (object.match !== undefined) {
    if (!Array.isArray(object.match)) {
      throw new ImageBatchUsageError(`${where}.match: expected a list of rules`)
    }
    config.match = object.match.map((item, i) => {
      const at = `${where}.match[${i}]`
      const rule = expectObject(item, at)
      checkKeys(rule, ['glob', 'outputs'], at)
      if (typeof rule.glob !== 'string' || rule.glob.trim() === '') {
        throw new ImageBatchUsageError(`${at}.glob: expected a glob string`)
      }
      if (!Array.isArray(rule.outputs) || rule.outputs.length === 0) {
        throw new ImageBatchUsageError(`${at}.outputs: expected a non-empty list of recipes`)
      }
      return {
        glob: rule.glob,
        outputs: rule.outputs.map((recipe, j) =>
          parseRecipeLayer(recipe, `${at}.outputs[${j}]`, RECIPE_KEYS),
        ),
      }
    })
  }
  if (object.placeholders !== undefined) {
    config.placeholders = parsePlaceholders(object.placeholders, `${where}.placeholders`)
  }

  const ids = new Set<string>()
  for (const recipe of config.outputs) {
    if (recipe.id === undefined) continue
    if (ids.has(recipe.id)) {
      throw new ImageBatchUsageError(`${where}.outputs: the recipe id "${recipe.id}" is used twice`)
    }
    ids.add(recipe.id)
  }
  for (const [name, preset] of Object.entries(config.presets)) {
    if (preset.extends !== undefined && config.presets[preset.extends] === undefined) {
      throw new ImageBatchUsageError(
        `${where}.presets.${name}.extends: unknown preset "${preset.extends}".${didYouMean(preset.extends, Object.keys(config.presets))}`,
      )
    }
  }
  for (const recipe of [...config.outputs, ...config.match.flatMap((rule) => rule.outputs)]) {
    if (recipe.preset !== undefined && config.presets[recipe.preset] === undefined) {
      throw new ImageBatchUsageError(
        `${where}: unknown preset "${recipe.preset}".${didYouMean(recipe.preset, Object.keys(config.presets))}`,
      )
    }
  }
  return config
}

function presetChain(config: BatchConfig, name: string, where: string): RecipeLayer[] {
  const chain: RecipeLayer[] = []
  const seen = new Set<string>()
  let current: string | undefined = name
  while (current !== undefined) {
    if (seen.has(current)) {
      throw new ImageBatchUsageError(
        `${where}: the presets extend each other in a loop at "${current}"`,
      )
    }
    seen.add(current)
    const preset: RecipeLayer | undefined = config.presets[current]
    if (!preset) throw new ImageBatchUsageError(`${where}: unknown preset "${current}"`)
    chain.unshift(preset)
    current = preset.extends
  }
  return chain
}

export function resolveRecipe(
  config: BatchConfig,
  recipe: RecipeLayer,
  overrides: RecipeLayer[] = [],
  where = 'recipe',
): ResolvedRecipe {
  const layers: RecipeLayer[] = [config.defaults]
  if (recipe.preset !== undefined) layers.push(...presetChain(config, recipe.preset, where))
  layers.push(recipe, ...overrides)

  const merged: RecipeLayer = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'codecs' || key === 'quality' || key === 'preset' || key === 'extends') continue
      if (key === 'sharpen' && value !== undefined) {
        const own = value as SharpenLayer
        const expanded = expandSharpen(own, config.sharpenPresets, where)
        merged.sharpen = own.preset !== undefined ? expanded : { ...merged.sharpen, ...expanded }
      } else if (value !== undefined) (merged as Record<string, unknown>)[key] = value
    }
  }
  if (merged.noResize) {
    delete merged.widths
    delete merged.heights
    delete merged.size
    delete merged.longEdge
    delete merged.shortEdge
    delete merged.megapixels
    delete merged.percent
    delete merged.scale
    delete merged.matchOrientation
  }
  const methods = [
    merged.widths,
    merged.heights,
    merged.size,
    merged.longEdge,
    merged.shortEdge,
    merged.megapixels,
    merged.percent,
  ]
  const firstMethod = methods.findIndex((method) => method !== undefined)
  const shape = {
    widths: firstMethod === 0,
    heights: firstMethod === 1,
    size: firstMethod === 2,
    longEdge: firstMethod === 3,
    shortEdge: firstMethod === 4,
    megapixels: firstMethod === 5,
    percent: firstMethod === 6,
    scale:
      firstMethod === -1 &&
      merged.scale !== undefined &&
      !(merged.scale.length === 1 && merged.scale[0] === 1),
  }
  const templateText = merged.template?.text ?? defaultTemplate(shape)
  const template = merged.template ?? {
    text: templateText,
    tokens: parseTemplate(templateText, `${where}.name`),
  }

  const resolved: ResolvedRecipe = {
    widths: merged.widths ?? [],
    heights: merged.heights ?? [],
    longEdge: merged.longEdge ?? [],
    shortEdge: merged.shortEdge ?? [],
    megapixels: merged.megapixels ?? [],
    percent: merged.percent ?? [],
    scales: merged.scale ?? [1],
    matchOrientation: merged.matchOrientation ?? false,
    explicitTemplate: merged.template !== undefined,
    formats: merged.formats ?? ['original'],
    layers: layers.map((layer) => {
      const codecLayer: CodecLayer = {}
      if (layer.codecs) codecLayer.codecs = layer.codecs
      if (layer.quality !== undefined) codecLayer.quality = layer.quality as QualityInput
      return codecLayer
    }),
    fit: merged.fit ?? 'inside',
    withoutEnlargement: merged.withoutEnlargement ?? true,
    template,
    autoOrient: merged.autoOrient ?? true,
    metadata: merged.metadata ?? 'strip',
    flip: merged.flip ?? false,
    flop: merged.flop ?? false,
    grayscale: merged.grayscale ?? false,
  }
  if (recipe.id !== undefined) resolved.id = recipe.id
  if (merged.size) resolved.size = merged.size
  if (merged.maxBytes !== undefined) resolved.maxBytes = merged.maxBytes
  if (merged.position) resolved.position = merged.position
  if (merged.background) resolved.background = merged.background
  if (merged.rotate !== undefined && merged.rotate !== 0) resolved.rotate = merged.rotate
  if (merged.sharpen !== undefined) resolved.sharpen = completeSharpen(merged.sharpen)
  if (merged.blur !== undefined) resolved.blur = merged.blur
  if (merged.flatten !== undefined) resolved.flatten = merged.flatten
  return resolved
}

export interface ConfigLocation {
  name: string
  path: string
  scope: 'project' | 'global'
  kind: 'json' | 'js' | 'mjs' | 'ts'
  editable: boolean
}

export interface DiscoverOptions {
  cwd: string
  globalDir?: string
}

export function globalConfigDir(homeDir: string = homedir()): string {
  return join(homeDir, ...CONFIG_DIR_SEGMENTS)
}

function listDir(dir: string, scope: ConfigLocation['scope']): ConfigLocation[] {
  const stat = statSync(dir, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) return []
  const found: ConfigLocation[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (!(CONFIG_EXTENSIONS as readonly string[]).includes(ext)) continue
    const kind = ext.slice(1) as ConfigLocation['kind']
    found.push({
      name: basename(entry.name, ext),
      path: join(dir, entry.name),
      scope,
      kind,
      editable: kind === 'json',
    })
  }
  return found
}

export function discoverConfigs(options: DiscoverOptions): ConfigLocation[] {
  const found: ConfigLocation[] = []
  const seenDirs = new Set<string>()
  const globalDir = resolve(options.globalDir ?? globalConfigDir())
  const homeGlobalDir = resolve(globalConfigDir())
  let dir = resolve(options.cwd)
  for (;;) {
    const candidate = join(dir, ...CONFIG_DIR_SEGMENTS)
    const resolved = resolve(candidate)
    if (resolved !== globalDir && resolved !== homeGlobalDir && !seenDirs.has(candidate)) {
      seenDirs.add(candidate)
      found.push(...listDir(candidate, 'project'))
    }
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  found.push(...listDir(globalDir, 'global'))
  return found
}

function looksLikePath(ref: string): boolean {
  return (
    /[\\/]/.test(ref) ||
    (CONFIG_EXTENSIONS as readonly string[]).includes(extname(ref).toLowerCase())
  )
}

export function locationForPath(path: string): ConfigLocation {
  const ext = extname(path).toLowerCase()
  if (!(CONFIG_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ImageBatchUsageError(
      `the config file "${path}" must end with ${CONFIG_EXTENSIONS.join(', ')}`,
    )
  }
  const kind = ext.slice(1) as ConfigLocation['kind']
  return {
    name: basename(path, ext),
    path,
    scope: 'project',
    kind,
    editable: kind === 'json',
  }
}

export function resolveConfigRef(
  ref: string,
  discovered: ConfigLocation[],
  cwd: string,
): ConfigLocation {
  if (looksLikePath(ref)) {
    const path = isAbsolute(ref) ? ref : resolve(cwd, ref)
    if (!existsSync(path)) {
      throw new ImageBatchUsageError(`config file not found: ${path}`)
    }
    return locationForPath(path)
  }
  const matches = discovered.filter((location) => location.name === ref)
  const chosen = matches.find((m) => m.scope === 'project') ?? matches[0]
  if (!chosen) {
    const names = [...new Set(discovered.map((location) => location.name))]
    throw new ImageBatchUsageError(
      `no config named "${ref}".${didYouMean(ref, names)} ${
        names.length > 0
          ? `Available: ${names.join(', ')}.`
          : 'None found — create one with `mediatoolz image-batch init`.'
      }`,
    )
  }
  return chosen
}

export async function readConfigSource(location: ConfigLocation): Promise<unknown> {
  if (location.kind === 'json') {
    const text = readFileSync(location.path, 'utf8')
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new ImageBatchUsageError(
        `${location.path}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  let url: string
  if (location.kind === 'ts') {
    const ts = await import('typescript')
    const source = readFileSync(location.path, 'utf8')
    const output = ts.default.transpileModule(source, {
      compilerOptions: {
        module: ts.default.ModuleKind.ESNext,
        target: ts.default.ScriptTarget.ES2022,
      },
    }).outputText
    url = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
  } else {
    url = `${pathToFileURL(location.path).href}?t=${Date.now()}`
  }
  let loaded: { default?: unknown }
  try {
    loaded = (await import(url)) as { default?: unknown }
  } catch (error) {
    throw new ImageBatchUsageError(
      `${location.path}: could not be loaded — ${error instanceof Error ? error.message : String(error)}${
        location.kind === 'ts'
          ? ' (a .ts config is transpiled on its own, so it cannot import other files)'
          : ''
      }`,
    )
  }
  const exported = loaded.default
  return typeof exported === 'function' ? await (exported as () => unknown)() : exported
}

export async function loadConfig(
  location: ConfigLocation,
): Promise<{ raw: unknown; config: BatchConfig }> {
  const raw = await readConfigSource(location)
  if (raw === undefined) {
    throw new ImageBatchUsageError(`${location.path}: the file has no default export`)
  }
  return { raw, config: parseConfig(raw, location.name) }
}

export function emptyConfig(): BatchConfig {
  return { defaults: {}, presets: {}, outputs: [], match: [] }
}
