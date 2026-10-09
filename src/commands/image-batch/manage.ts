import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { createStyle, type Style } from '../../format/style.js'
import type { VibesOptions } from '../../format/vibes.js'
import { renderTable, type TableColumn } from '../../format/table.js'
import {
  askText,
  isInteractive,
  multiSelect,
  promptChoice,
  singleSelect,
  type SelectItem,
  type TerminalIO,
} from '../../utils/tty.js'
import { parseCodecArgs, parseQualityArg } from './codecs.js'
import {
  CONFIG_DIR_SEGMENTS,
  METADATA_MODES,
  POSITIONS,
  discoverConfigs,
  globalConfigDir,
  parseConfig,
  parseRecipeLayer,
  readConfigSource,
  resolveRecipe,
  type BatchConfig,
  type ConfigLocation,
  type ResolvedRecipe,
} from './config.js'
import { ImageBatchUsageError } from './errors.js'
import { FIT_MODES } from './geometry.js'
import { renderImageBatchReport } from './report.js'
import { askSharpenFields } from './sharpen-ask.js'
import { attachSharpenPresets, discoverSharpenPresets } from './sharpen-presets.js'
import {
  SHARPEN_AMOUNTS,
  describeSharpen,
  type SharpenFields,
  type SharpenLayer,
  type SharpenTarget,
} from './sharpen.js'
import { defaultTemplate } from './template.js'
import { runImageBatch, type ImageBatchOptions, type ImageBatchReport } from './run.js'

export interface ManageEnv {
  cwd: string
  io: TerminalIO
  style: VibesOptions
  globalDir?: string
  log: (text: string) => void
  runBatch?: (options: ImageBatchOptions) => Promise<ImageBatchReport>
}

type Raw = Record<string, unknown>

export function configDir(
  scope: 'project' | 'global',
  env: Pick<ManageEnv, 'cwd' | 'globalDir'>,
): string {
  return scope === 'global'
    ? (env.globalDir ?? globalConfigDir())
    : join(env.cwd, ...CONFIG_DIR_SEGMENTS)
}

function detectIndent(text: string): number | string {
  const match = /\n([ \t]+)"/.exec(text)
  if (!match) return 2
  const indent = match[1] as string
  return indent.includes('\t') ? '\t' : indent.length
}

export function writeJson(path: string, value: unknown, indent: number | string = 2): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`)
}

function readRawJson(location: ConfigLocation): { raw: Raw; indent: number | string } {
  const text = readFileSync(location.path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ImageBatchUsageError(
      `${location.path}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ImageBatchUsageError(`${location.path}: expected a JSON object`)
  }
  return { raw: parsed as Raw, indent: detectIndent(text) }
}

export function validName(name: string): string {
  const trimmed = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new ImageBatchUsageError(
      `"${name}" is not a usable config name — use letters, digits, dot, dash and underscore`,
    )
  }
  return trimmed
}

export interface InitOptions {
  name?: string
  global?: boolean
  widths?: number[]
  sizeFields?: Record<string, unknown>
  formats?: string[]
  quality?: string
  fileName?: string
  sharpen?: SharpenLayer
  thumbnail?: boolean
  hazehash?: boolean
  force?: boolean
}

export function buildStarterConfig(options: InitOptions, title: string): Raw {
  const sizeFields = options.sizeFields ?? { widths: options.widths ?? [400, 800, 1200] }
  const formats = options.formats ?? ['avif', 'webp', 'jpg']
  const outputs: Raw[] = [
    {
      id: 'responsive',
      ...sizeFields,
      formats,
      ...(options.quality ? { quality: parseQualityArg(options.quality) } : { quality: 'high' }),
      ...(options.fileName ? { name: options.fileName } : {}),
      ...(options.sharpen
        ? {
            sharpen:
              Object.keys(options.sharpen).length === 1 && options.sharpen.preset !== undefined
                ? options.sharpen.preset
                : options.sharpen,
          }
        : {}),
    },
  ]
  if (options.thumbnail) {
    outputs.push({
      id: 'thumb',
      size: '200x200',
      fit: 'cover',
      formats: ['webp'],
      name: '{dir}/{name}-thumb.{format}',
    })
  }
  const config: Raw = {
    name: title,
    description: 'Created by mediatoolz image-batch init',
    outputs,
  }
  if (options.hazehash) config.placeholders = { hazehash: { budget: 28 } }
  parseConfig(config, title)
  return config
}

const FORMAT_CHOICES: SelectItem<string>[] = [
  { label: 'avif', hint: 'smallest files, slower to make', value: 'avif', selected: true },
  { label: 'webp', hint: 'small, supported everywhere', value: 'webp', selected: true },
  { label: 'jpg', hint: 'photos, works with everything', value: 'jpg', selected: true },
  { label: 'png', hint: 'lossless, keeps transparency', value: 'png' },
  { label: 'gif', hint: 'animation, up to 256 colors', value: 'gif' },
  { label: 'tiff', hint: 'print and archive', value: 'tiff' },
  { label: 'heif', hint: 'HEIF container, av1', value: 'heif' },
  { label: 'original', hint: "keep each file's own format", value: 'original' },
]

async function pickFormats(env: ManageEnv, style: Style): Promise<string[]> {
  for (;;) {
    const picked = await multiSelect(
      env.io,
      FORMAT_CHOICES.map((item) => ({ ...item })),
      {
        title: 'Which formats should the config produce?',
        help: 'space tick · a all · n none · i invert · enter confirm · q cancel',
      },
      style,
    )
    if (picked === null) throw new ImageBatchUsageError('cancelled')
    if (picked.length > 0) return picked
    env.log(style.warn('Pick at least one format.'))
  }
}

type SizeMethod =
  'widths' | 'heights' | 'size' | 'longEdge' | 'shortEdge' | 'megapixels' | 'percent' | 'original'

const SIZE_METHODS: {
  value: SizeMethod
  label: string
  hint: string
  sample: string
  question: string
}[] = [
  {
    value: 'widths',
    label: 'Width',
    hint: 'one side is given, the other follows the proportions',
    sample: '400,800,1200',
    question: 'Widths in pixels (comma-separated):',
  },
  {
    value: 'heights',
    label: 'Height',
    hint: 'the same, by height',
    sample: '300,600',
    question: 'Heights in pixels (comma-separated):',
  },
  {
    value: 'size',
    label: 'Box (width × height)',
    hint: 'fit inside it, or fill it exactly',
    sample: '1920x1080',
    question: 'Box, width x height:',
  },
  {
    value: 'longEdge',
    label: 'Long side',
    hint: 'the same for landscape and portrait images',
    sample: '1600',
    question: 'Long side in pixels (comma-separated):',
  },
  {
    value: 'shortEdge',
    label: 'Short side',
    hint: 'the same for landscape and portrait images',
    sample: '1080',
    question: 'Short side in pixels (comma-separated):',
  },
  {
    value: 'megapixels',
    label: 'Megapixels',
    hint: 'by area, whatever the proportions',
    sample: '2,0.5',
    question: 'Megapixels (comma-separated):',
  },
  {
    value: 'percent',
    label: 'Percentage',
    hint: 'of the source size',
    sample: '50,25',
    question: 'Percentages (comma-separated):',
  },
  {
    value: 'original',
    label: 'Original size',
    hint: 'only convert or recompress',
    sample: '',
    question: '',
  },
]

const SIZE_FIELDS = [
  'widths',
  'heights',
  'size',
  'longEdge',
  'shortEdge',
  'megapixels',
  'percent',
  'matchOrientation',
] as const

const FIT_CHOICES: SelectItem<string>[] = [
  { label: 'inside', hint: 'the whole image, proportions kept', value: 'inside' },
  { label: 'cover', hint: 'fill the box, crop what does not fit', value: 'cover' },
  { label: 'contain', hint: 'the whole image, padded to the box', value: 'contain' },
  { label: 'outside', hint: 'cover the box without cropping', value: 'outside' },
  { label: 'fill', hint: 'stretch to the box', value: 'fill' },
]

export async function chooseSizeMethod(
  env: ManageEnv,
  style: Style,
  current?: Raw,
): Promise<Raw | null> {
  const method = await singleSelect(
    env.io,
    SIZE_METHODS.map((entry) => ({ label: entry.label, hint: entry.hint, value: entry.value })),
    { title: 'How should the size be chosen?', help: 'enter pick · q cancel' },
    style,
  )
  if (method === null) return null
  if (method === 'original') return {}
  const entry = SIZE_METHODS.find(
    (candidate) => candidate.value === method,
  ) as (typeof SIZE_METHODS)[number]
  const existing = current?.[method]
  const initial =
    existing === undefined
      ? entry.sample
      : Array.isArray(existing)
        ? existing.join(',')
        : String(existing)
  const answer = await askText(env.io, entry.question, style, initial)
  if (answer === null) return null
  const text = answer.trim()
  if (method === 'size') {
    const fit = await singleSelect(
      env.io,
      FIT_CHOICES.map((item) => ({ ...item })),
      { title: 'How should the image fill the box?', help: 'enter pick · q keep "inside"' },
      style,
    )
    const turn = await promptChoice(
      env.io,
      'Turn the box around for images of the other orientation?',
      [
        { key: 'y', label: 'yes' },
        { key: 'n', label: 'no' },
      ],
      style,
      'n',
    )
    return {
      size: text,
      ...(fit && fit !== 'inside' ? { fit } : {}),
      ...(turn === 'y' ? { matchOrientation: true } : {}),
    }
  }
  const numbers = text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
  if (numbers.length === 0 || numbers.some((value) => !Number.isFinite(value))) {
    throw new ImageBatchUsageError(`${entry.label}: expected numbers separated by commas`)
  }
  return { [method]: numbers }
}

export async function runInit(env: ManageEnv, options: InitOptions): Promise<string> {
  const s = createStyle(env.style)
  const interactive = isInteractive(env.io)
  const settings: InitOptions = { ...options }

  if (settings.name === undefined) {
    if (!interactive) {
      throw new ImageBatchUsageError('init needs --name <name> when it is not run in a terminal')
    }
    const answer = await askText(env.io, 'Name of the config:', s, 'web')
    if (answer === null) throw new ImageBatchUsageError('cancelled')
    settings.name = answer
  }
  const name = validName(settings.name)

  if (interactive && options.global === undefined) {
    const scope = await singleSelect(
      env.io,
      [
        { label: 'This project', hint: configDir('project', env), value: 'project' as const },
        {
          label: 'Global (all projects)',
          hint: configDir('global', env),
          value: 'global' as const,
        },
      ],
      { title: 'Where should the config be saved?', help: 'enter pick · q cancel' },
      s,
    )
    if (scope === null) throw new ImageBatchUsageError('cancelled')
    settings.global = scope === 'global'
  }
  if (interactive && options.widths === undefined && options.sizeFields === undefined) {
    const fields = await chooseSizeMethod(env, s)
    if (fields === null) throw new ImageBatchUsageError('cancelled')
    settings.sizeFields = fields
  }
  if (interactive && options.formats === undefined) {
    settings.formats = await pickFormats(env, s)
  }
  if (interactive && options.quality === undefined) {
    const level = await singleSelect(
      env.io,
      (['low', 'medium', 'high', 'best'] as const).map((value) => ({
        label: value,
        hint: value === 'high' ? 'recommended' : '',
        value,
      })),
      { title: 'Quality level', help: 'enter pick · q keep "high"' },
      s,
    )
    settings.quality = level ?? 'high'
  }
  if (interactive && options.fileName === undefined) {
    const fallback = defaultTemplate({ widths: true })
    env.log(
      s.muted(
        'Variables: {name} {ext} {orig} {dir} {format} {width} {height} {size} {long} {short} {mp} {percent} {scale} {index:3} {hash} {date}',
      ),
    )
    const answer = await askText(
      env.io,
      'File name template (Enter keeps the default):',
      s,
      fallback,
    )
    if (answer === null) throw new ImageBatchUsageError('cancelled')
    const chosen = answer.trim()
    if (chosen !== '' && chosen !== fallback) settings.fileName = chosen
  }
  if (interactive && options.sharpen === undefined) {
    const presets = [
      ...new Set(
        discoverSharpenPresets({
          cwd: env.cwd,
          ...(env.globalDir !== undefined ? { globalDir: env.globalDir } : {}),
        }).map((location) => location.name),
      ),
    ]
    const target = await singleSelect(
      env.io,
      [
        { label: '(none)', hint: 'no sharpening', value: '' },
        { label: 'screen', hint: 'light, for web and displays', value: 'screen' },
        { label: 'matte', hint: 'medium, for matte paper', value: 'matte' },
        { label: 'glossy', hint: 'strong, for glossy paper', value: 'glossy' },
        ...presets.map((name) => ({ label: name, hint: 'saved preset', value: `preset:${name}` })),
      ],
      { title: 'Sharpen the results after resizing?', help: 'enter pick · q none' },
      s,
    )
    if (target?.startsWith('preset:')) {
      settings.sharpen = { preset: target.slice('preset:'.length) }
    } else if (target) {
      const amount = await singleSelect(
        env.io,
        SHARPEN_AMOUNTS.map((value) => ({
          label: value,
          hint: value === 'standard' ? 'recommended' : '',
          value,
        })),
        { title: 'Sharpening amount', help: 'enter pick · q keep "standard"' },
        s,
      )
      settings.sharpen = { for: target as SharpenTarget, amount: amount ?? 'standard' }
    }
  }
  if (interactive && options.thumbnail === undefined) {
    const answer = await promptChoice(
      env.io,
      'Add a 200×200 cropped thumbnail recipe?',
      [
        { key: 'y', label: 'yes' },
        { key: 'n', label: 'no' },
      ],
      s,
      'n',
    )
    settings.thumbnail = answer === 'y'
  }
  if (interactive && options.hazehash === undefined) {
    const answer = await promptChoice(
      env.io,
      'Compute a hazehash preview for the --emit manifest?',
      [
        { key: 'y', label: 'yes' },
        { key: 'n', label: 'no' },
      ],
      s,
      'n',
    )
    settings.hazehash = answer === 'y'
  }

  const scope = settings.global ? 'global' : 'project'
  const dir = configDir(scope, env)
  const path = join(dir, `${name}.json`)
  if (existsSync(path) && !settings.force) {
    throw new ImageBatchUsageError(`${path} already exists — pick another name or pass --force`)
  }
  writeJson(path, buildStarterConfig(settings, name))
  env.log(`${s.success('Created')} ${s.path(path)}`)
  env.log(
    s.hint(
      `(use it with: mediatoolz image-batch <folder> -o <out> -c ${name} — edit it with: mediatoolz image-batch config)`,
    ),
  )
  return path
}

export interface ConfigRow {
  location: ConfigLocation
  title?: string
  description?: string
  recipes: number
  rules: number
  error?: string
}

export async function describeLocation(location: ConfigLocation): Promise<ConfigRow> {
  try {
    const raw = await readConfigSource(location)
    const config = parseConfig(raw, location.name)
    return {
      location,
      ...(config.title !== undefined ? { title: config.title } : {}),
      ...(config.description !== undefined ? { description: config.description } : {}),
      recipes: config.outputs.length,
      rules: config.match.length,
    }
  } catch (error) {
    return {
      location,
      recipes: 0,
      rules: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function listConfigRows(env: ManageEnv): Promise<ConfigRow[]> {
  const discovered = discoverConfigs({
    cwd: env.cwd,
    ...(env.globalDir !== undefined ? { globalDir: env.globalDir } : {}),
  })
  return Promise.all(discovered.map(describeLocation))
}

export function renderConfigTable(rows: ConfigRow[], style: VibesOptions): string[] {
  const s = createStyle(style)
  const columns: TableColumn[] = [
    { header: 'Name', style: s.name },
    { header: 'Scope', style: s.accent },
    { header: 'Recipes', align: 'right', style: s.value },
    { header: 'Rules', align: 'right', style: s.value },
    { header: 'Path', shrink: true, style: s.path },
  ]
  return renderTable(
    columns,
    rows.map((row) => [
      row.location.name,
      row.location.scope,
      row.error ? 'error' : String(row.recipes),
      row.error ? '' : String(row.rules),
      row.location.path,
    ]),
    style,
  )
}

function defaultNames(resolved: ResolvedRecipe): string {
  const names: string[] = []
  const add = (shape: Parameters<typeof defaultTemplate>[0]) => {
    const text = defaultTemplate(shape)
    if (!names.includes(text)) names.push(text)
  }
  if (resolved.widths.length) add({ widths: true })
  if (resolved.heights.length) add({ heights: true })
  if (resolved.size) add({ size: true })
  if (resolved.longEdge.length) add({ longEdge: true })
  if (resolved.shortEdge.length) add({ shortEdge: true })
  if (resolved.megapixels.length) add({ megapixels: true })
  if (resolved.percent.length) add({ percent: true })
  if (names.length === 0) add({ scale: resolved.scales.some((x) => x !== 1) })
  return names.join('   ')
}

function recipeSummary(layer: Raw): string {
  const parts: string[] = []
  const list = (value: unknown) => (Array.isArray(value) ? value.join(',') : String(value))
  if (layer.preset) parts.push(`preset ${String(layer.preset)}`)
  if (layer.widths) parts.push(`w ${list(layer.widths)}`)
  if (layer.heights) parts.push(`h ${list(layer.heights)}`)
  if (layer.size) parts.push(`size ${String(layer.size)}`)
  if (layer.longEdge) parts.push(`long ${list(layer.longEdge)}`)
  if (layer.shortEdge) parts.push(`short ${list(layer.shortEdge)}`)
  if (layer.megapixels) parts.push(`${list(layer.megapixels)} MP`)
  if (layer.percent) parts.push(`${list(layer.percent)}%`)
  if (layer.scale) parts.push(`×${list(layer.scale)}`)
  if (layer.formats) {
    parts.push(
      Array.isArray(layer.formats)
        ? layer.formats.join('/')
        : typeof layer.formats === 'object' && layer.formats !== null
          ? Object.keys(layer.formats).join('/')
          : String(layer.formats),
    )
  }
  if (layer.quality !== undefined) {
    parts.push(
      `q ${typeof layer.quality === 'object' ? JSON.stringify(layer.quality) : String(layer.quality)}`,
    )
  }
  if (layer.fit) parts.push(`fit ${String(layer.fit)}`)
  if (typeof layer.sharpen === 'string') parts.push(`sharpen ${layer.sharpen}`)
  else if (layer.sharpen && typeof layer.sharpen === 'object') {
    parts.push(`sharpen ${describeSharpen(layer.sharpen as SharpenLayer)}`)
  }
  return parts.join(' · ')
}

export function describeConfigLines(config: BatchConfig, style: VibesOptions): string[] {
  const s = createStyle(style)
  const lines: string[] = []
  if (config.title)
    lines.push(
      `${s.heading(config.title)}${config.description ? s.muted(` — ${config.description}`) : ''}`,
    )
  const printRecipe = (label: string, layer: BatchConfig['defaults']) => {
    const resolved = resolveRecipe(config, layer)
    const dims = [
      resolved.widths.length ? `widths ${resolved.widths.join(', ')}` : '',
      resolved.heights.length ? `heights ${resolved.heights.join(', ')}` : '',
      resolved.size
        ? `box ${resolved.size.width}×${resolved.size.height}${resolved.matchOrientation ? ' (matches orientation)' : ''}`
        : '',
      resolved.longEdge.length ? `long side ${resolved.longEdge.join(', ')}` : '',
      resolved.shortEdge.length ? `short side ${resolved.shortEdge.join(', ')}` : '',
      resolved.megapixels.length ? `${resolved.megapixels.join(', ')} MP` : '',
      resolved.percent.length ? `${resolved.percent.join(', ')}%` : '',
      resolved.scales.some((x) => x !== 1) ? `scale ${resolved.scales.join(', ')}` : '',
    ].filter(Boolean)
    lines.push(
      `  ${s.name(label)}  ${s.value(dims.join(' · ') || 'original size')}  ${s.muted('→')} ${s.accent(resolved.formats.join(', '))}  ${s.muted(`fit ${resolved.fit}`)}`,
    )
    lines.push(
      `      ${s.muted('name')} ${s.path(resolved.explicitTemplate ? resolved.template.text : defaultNames(resolved))}${resolved.maxBytes ? `  ${s.muted(`limit ${Math.round(resolved.maxBytes / 1024)} KB`)}` : ''}`,
    )
  }
  if (config.outputs.length > 0) {
    lines.push(s.heading('Recipes'))
    config.outputs.forEach((layer, i) => printRecipe(layer.id ?? `#${i + 1}`, layer))
  }
  if (config.match.length > 0) {
    lines.push(s.heading('Rules'))
    config.match.forEach((rule) => {
      lines.push(`  ${s.accent(rule.glob)}`)
      rule.outputs.forEach((layer, i) => printRecipe(`  ${layer.id ?? `#${i + 1}`}`, layer))
    })
  }
  if (config.placeholders) {
    lines.push(
      s.heading('Placeholders'),
      `  ${s.value(config.placeholders.types.join(', '))}${config.placeholders.budget ? s.muted(` (hazehash ${config.placeholders.budget} bytes)`) : ''}`,
    )
  }
  return lines
}

export async function showConfig(env: ManageEnv, location: ConfigLocation): Promise<void> {
  const raw = await readConfigSource(location)
  const config = attachSharpenPresets(parseConfig(raw, location.name), {
    cwd: env.cwd,
    ...(env.globalDir !== undefined ? { globalDir: env.globalDir } : {}),
  })
  env.log(describeConfigLines(config, env.style).join('\n'))
}

export function removeConfigFile(location: ConfigLocation, force: boolean): string {
  if (force) {
    rmSync(location.path, { force: true })
    return location.path
  }
  const backup = `${location.path}.bak`
  if (existsSync(backup)) rmSync(backup, { force: true })
  renameSync(location.path, backup)
  return backup
}

function uniquePath(dir: string, name: string, kind: string): string {
  return join(dir, `${name}.${kind}`)
}

const FIELD_KEYS = [
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

function currentValue(layer: Raw, key: string): string {
  const value = layer[key]
  if (value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

async function pickFrom<T extends string>(
  env: ManageEnv,
  s: Style,
  title: string,
  options: readonly T[],
  allowUnset: boolean,
): Promise<T | '' | null> {
  const items: SelectItem<T | ''>[] = options.map((value) => ({ label: value, value }))
  if (allowUnset) items.unshift({ label: '(unset)', hint: 'remove the setting', value: '' })
  return singleSelect(env.io, items, { title, help: 'enter pick · q cancel' }, s)
}

function csvNumbers(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((part) => Number(part))
}

async function editField(
  env: ManageEnv,
  s: Style,
  layer: Raw,
  key: string,
  presets: string[],
): Promise<boolean> {
  const current = currentValue(layer, key)
  const set = (value: unknown) => {
    if (value === undefined || value === '') delete layer[key]
    else layer[key] = value
  }
  const askRaw = async (question: string) => {
    const answer = await askText(env.io, question, s, current)
    return answer === null ? undefined : answer.trim()
  }
  switch (key) {
    case 'fit':
    case 'position':
    case 'metadata': {
      const choices = key === 'fit' ? FIT_MODES : key === 'position' ? POSITIONS : METADATA_MODES
      const picked = await pickFrom(env, s, `${key}`, choices, true)
      if (picked === null) return false
      set(picked)
      return true
    }
    case 'preset': {
      const picked = await pickFrom(env, s, 'preset', presets, true)
      if (picked === null) return false
      set(picked)
      return true
    }
    case 'rotate': {
      const picked = await pickFrom(env, s, 'rotate', ['90', '180', '270'], true)
      if (picked === null) return false
      set(picked === '' ? undefined : Number(picked))
      return true
    }
    case 'withoutEnlargement':
    case 'matchOrientation':
    case 'autoOrient':
    case 'flip':
    case 'flop':
    case 'grayscale': {
      const picked = await pickFrom(env, s, key, ['true', 'false'], true)
      if (picked === null) return false
      set(picked === '' ? undefined : picked === 'true')
      return true
    }
    case 'widths':
    case 'heights':
    case 'longEdge':
    case 'shortEdge':
    case 'megapixels':
    case 'percent':
    case 'scale': {
      const answer = await askRaw(`${key} (comma-separated, empty = remove):`)
      if (answer === undefined) return false
      set(answer === '' ? undefined : csvNumbers(answer))
      return true
    }
    case 'formats': {
      const answer = await askRaw('formats (comma-separated, empty = remove):')
      if (answer === undefined) return false
      set(answer === '' ? undefined : answer.split(/[,\s]+/).filter(Boolean))
      return true
    }
    case 'quality': {
      const answer = await askRaw('quality (82, high, or jpg=82,webp=high; empty = remove):')
      if (answer === undefined) return false
      set(answer === '' ? undefined : parseQualityArg(answer))
      return true
    }
    case 'codecs': {
      const answer = await askRaw(
        'codec options, e.g. jpg.mozjpeg=true png.colors=64 (empty = remove all):',
      )
      if (answer === undefined) return false
      if (answer === '') {
        set(undefined)
        return true
      }
      const map = parseCodecArgs(answer.split(/\s+/).filter(Boolean))
      const merged: Record<string, Record<string, unknown>> = {
        ...((layer.codecs as Record<string, Record<string, unknown>> | undefined) ?? {}),
      }
      for (const [format, options] of Object.entries(map)) {
        merged[format] = { ...merged[format], ...options }
      }
      layer.codecs = merged
      return true
    }
    case 'sharpen': {
      const how = await pickFrom(env, s, 'sharpen', ['preset', 'custom'], true)
      if (how === null) return false
      if (how === '') {
        set(undefined)
        return true
      }
      if (how === 'preset') {
        const names = [
          ...new Set(
            discoverSharpenPresets({
              cwd: env.cwd,
              ...(env.globalDir !== undefined ? { globalDir: env.globalDir } : {}),
            }).map((location) => location.name),
          ),
        ]
        if (names.length === 0) {
          env.log(
            s.warn(
              'No sharpen presets yet — create one with `mediatoolz image-batch sharpen new`.',
            ),
          )
          return false
        }
        const name = await pickFrom(env, s, 'Sharpen preset', names, false)
        if (name === null || name === '') return false
        set(name)
        return true
      }
      const fields = await askSharpenFields(
        env,
        s,
        typeof layer.sharpen === 'object' && layer.sharpen !== null
          ? (layer.sharpen as SharpenFields)
          : {},
      )
      if (fields === null) return false
      set(fields)
      return true
    }
    case 'blur': {
      const answer = await askRaw('blur sigma (0.3–1000; empty = remove):')
      if (answer === undefined) return false
      set(answer === '' ? undefined : Number(answer))
      return true
    }
    case 'flatten': {
      const answer = await askRaw(
        'flatten (true, or a background color like #ffffff; empty = remove):',
      )
      if (answer === undefined) return false
      set(answer === '' ? undefined : answer === 'true' ? true : answer)
      return true
    }
    default: {
      const answer = await askRaw(`${key} (empty = remove):`)
      if (answer === undefined) return false
      set(answer === '' ? undefined : answer)
      return true
    }
  }
}

async function editRecipe(
  env: ManageEnv,
  s: Style,
  raw: Raw,
  layer: Raw,
  title: string,
  save: () => void,
): Promise<'saved' | 'back' | 'removed'> {
  const presets = Object.keys((raw.presets as Raw | undefined) ?? {})
  for (;;) {
    const sizePart: Raw = {}
    for (const key of SIZE_FIELDS) if (layer[key] !== undefined) sizePart[key] = layer[key]
    const items: SelectItem<string>[] = [
      {
        label: '→ size method…',
        hint: recipeSummary(sizePart) || 'original size',
        value: '__size',
      },
      ...FIELD_KEYS.map((key) => ({ label: key, hint: currentValue(layer, key), value: key })),
      { label: '— remove this recipe —', value: '__remove' },
      { label: '— back —', value: '__back' },
    ]
    const picked = await singleSelect(
      env.io,
      items,
      { title: `Edit ${title}`, help: 'enter edit a field · q back', filterable: true },
      s,
    )
    if (picked === null || picked === '__back') return 'back'
    if (picked === '__size') {
      const before = JSON.stringify(layer)
      try {
        const fields = await chooseSizeMethod(env, s, layer)
        if (fields === null) continue
        for (const key of SIZE_FIELDS) delete layer[key]
        Object.assign(layer, fields)
        parseRecipeLayer(layer, title, [...FIELD_KEYS, 'extends'])
        save()
      } catch (error) {
        for (const key of Object.keys(layer)) delete layer[key]
        Object.assign(layer, JSON.parse(before))
        env.log(s.error(error instanceof Error ? error.message : String(error)))
      }
      continue
    }
    if (picked === '__remove') {
      const sure = await promptChoice(
        env.io,
        `${s.warn('Remove')} ${s.name(title)}?`,
        [
          { key: 'y', label: 'yes, remove' },
          { key: 'n', label: 'no' },
        ],
        s,
        'n',
      )
      if (sure === 'y') return 'removed'
      continue
    }
    const before = JSON.stringify(layer)
    try {
      const changed = await editField(env, s, layer, picked, presets)
      if (!changed) continue
      parseRecipeLayer(layer, title, [...FIELD_KEYS, 'extends'])
      save()
    } catch (error) {
      for (const key of Object.keys(layer)) delete layer[key]
      Object.assign(layer, JSON.parse(before))
      env.log(s.error(error instanceof Error ? error.message : String(error)))
    }
  }
}

async function editConfig(env: ManageEnv, s: Style, location: ConfigLocation): Promise<void> {
  if (!location.editable) {
    env.log(
      s.warn(
        `${location.name} is a .${location.kind} file — only .json configs can be edited here.`,
      ),
    )
    return
  }
  const { raw, indent } = readRawJson(location)
  const save = () => {
    parseConfig(raw, location.name)
    writeJson(location.path, raw, indent)
  }
  for (;;) {
    const outputs = (raw.outputs as Raw[] | undefined) ?? []
    const rules = (raw.match as { glob: string; outputs: Raw[] }[] | undefined) ?? []
    const items: SelectItem<string>[] = [
      ...outputs.map((layer, i) => ({
        label: `recipe ${String(layer.id ?? `#${i + 1}`)}`,
        hint: recipeSummary(layer),
        value: `o:${i}`,
      })),
      ...rules.flatMap((rule, ri) =>
        rule.outputs.map((layer, i) => ({
          label: `rule ${rule.glob} → ${String(layer.id ?? `#${i + 1}`)}`,
          hint: recipeSummary(layer),
          value: `m:${ri}:${i}`,
        })),
      ),
      { label: '+ add a recipe', value: '__add' },
      { label: 'title and description', hint: String(raw.name ?? ''), value: '__title' },
      {
        label: 'defaults',
        hint: recipeSummary((raw.defaults as Raw | undefined) ?? {}),
        value: '__defaults',
      },
      {
        label: 'placeholders',
        hint: JSON.stringify(raw.placeholders ?? {}),
        value: '__placeholders',
      },
      { label: '— done —', value: '__done' },
    ]
    const picked = await singleSelect(
      env.io,
      items,
      { title: `Edit ${location.name}`, help: 'enter open · q done', filterable: true },
      s,
    )
    if (picked === null || picked === '__done') return
    try {
      if (picked === '__add') {
        const fields = await chooseSizeMethod(env, s)
        if (fields === null) continue
        const list = (raw.outputs ??= []) as Raw[]
        list.push({ ...fields, formats: ['webp'] })
        save()
        await editRecipe(env, s, raw, list[list.length - 1] as Raw, `recipe #${list.length}`, save)
        continue
      }
      if (picked === '__title') {
        const title = await askText(env.io, 'Title:', s, String(raw.name ?? ''))
        if (title !== null) {
          if (title.trim() === '') delete raw.name
          else raw.name = title.trim()
        }
        const description = await askText(env.io, 'Description:', s, String(raw.description ?? ''))
        if (description !== null) {
          if (description.trim() === '') delete raw.description
          else raw.description = description.trim()
        }
        save()
        continue
      }
      if (picked === '__defaults') {
        const defaults = (raw.defaults ??= {}) as Raw
        await editRecipe(env, s, raw, defaults, 'defaults', save)
        if (Object.keys(defaults).length === 0) delete raw.defaults
        save()
        continue
      }
      if (picked === '__placeholders') {
        const answer = await askText(
          env.io,
          'Placeholders (hazehash, blurhash, thumbhash, color; empty = none):',
          s,
          Object.keys((raw.placeholders as Raw | undefined) ?? {}).join(', '),
        )
        if (answer !== null) {
          const names = answer.split(/[,\s]+/).filter(Boolean)
          if (names.length === 0) delete raw.placeholders
          else {
            const previous = (raw.placeholders as Raw | undefined) ?? {}
            raw.placeholders = Object.fromEntries(names.map((n) => [n, previous[n] ?? true]))
          }
          save()
        }
        continue
      }
      if (picked.startsWith('o:')) {
        const index = Number(picked.slice(2))
        const layer = outputs[index] as Raw
        const result = await editRecipe(
          env,
          s,
          raw,
          layer,
          `recipe ${String(layer.id ?? `#${index + 1}`)}`,
          save,
        )
        if (result === 'removed') {
          outputs.splice(index, 1)
          save()
        }
        continue
      }
      const [, ri, i] = picked.split(':')
      const rule = rules[Number(ri)] as { glob: string; outputs: Raw[] }
      const layer = rule.outputs[Number(i)] as Raw
      const result = await editRecipe(env, s, raw, layer, `rule ${rule.glob}`, save)
      if (result === 'removed' && rule.outputs.length > 1) {
        rule.outputs.splice(Number(i), 1)
        save()
      }
    } catch (error) {
      env.log(s.error(error instanceof Error ? error.message : String(error)))
    }
  }
}

function copyOrWrite(source: ConfigLocation, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(source.path, targetPath)
}

export async function manageConfigs(env: ManageEnv): Promise<void> {
  const s = createStyle(env.style)
  if (!isInteractive(env.io)) {
    const rows = await listConfigRows(env)
    env.log(
      rows.length === 0
        ? s.warn('No configs found — create one with `mediatoolz image-batch init`.')
        : renderConfigTable(rows, env.style).join('\n'),
    )
    return
  }
  for (;;) {
    const rows = await listConfigRows(env)
    const items: SelectItem<ConfigRow | 'new'>[] = [
      ...rows.map((row) => ({
        label: row.location.name,
        hint: row.error
          ? `unreadable — ${row.error.slice(0, 50)}`
          : `${row.location.scope} · ${row.recipes} recipe${row.recipes === 1 ? '' : 's'}${row.rules ? ` · ${row.rules} rule${row.rules === 1 ? '' : 's'}` : ''}${row.title ? ` · ${row.title}` : ''}`,
        value: row,
      })),
      { label: '+ new config', hint: 'wizard', value: 'new' as const },
    ]
    const picked = await singleSelect(
      env.io,
      items,
      { title: 'Configs', help: 'enter open · / filter · q quit', filterable: true },
      s,
    )
    if (picked === null) return
    if (picked === 'new') {
      try {
        await runInit(env, {})
      } catch (error) {
        env.log(s.error(error instanceof Error ? error.message : String(error)))
      }
      continue
    }
    const location = picked.location
    const action = await singleSelect(
      env.io,
      [
        {
          label: 'Apply to a folder',
          hint: 'asks for the input and output folders',
          value: 'apply',
        },
        { label: 'Show', hint: 'what it produces', value: 'show' },
        {
          label: 'Edit',
          hint: location.editable ? 'recipes and settings' : 'read-only (.json only)',
          value: 'edit',
        },
        { label: 'Duplicate', value: 'duplicate' },
        { label: 'Rename', value: 'rename' },
        {
          label: location.scope === 'project' ? 'Copy to global' : 'Copy to this project',
          value: 'copy',
        },
        { label: 'Delete', value: 'delete' },
        { label: '— back —', value: 'back' },
      ],
      { title: `${location.name}  ${location.scope}`, help: 'enter pick · q back' },
      s,
    )
    try {
      switch (action) {
        case 'apply': {
          const input = await askText(env.io, 'Input folder or files (space-separated):', s, '.')
          if (input === null) break
          const out = await askText(env.io, 'Output folder:', s)
          if (out === null || out.trim() === '') break
          const recursive = await promptChoice(
            env.io,
            'Include subfolders?',
            [
              { key: 'y', label: 'yes' },
              { key: 'n', label: 'no' },
            ],
            s,
            'y',
          )
          const raw = await readConfigSource(location)
          const config = parseConfig(raw, location.name)
          const run = env.runBatch ?? runImageBatch
          const report = await run({
            paths: input.split(/\s+/).filter(Boolean),
            cwd: env.cwd,
            out: out.trim(),
            config,
            configLabel: location.name,
            recursive: recursive === 'y',
            io: env.io,
            interactive: true,
            style: env.style,
          })
          env.log(renderImageBatchReport(report, env.style))
          break
        }
        case 'show':
          await showConfig(env, location)
          break
        case 'edit':
          await editConfig(env, s, location)
          break
        case 'duplicate':
        case 'copy': {
          const defaultName = action === 'duplicate' ? `${location.name}-copy` : location.name
          const name = await askText(env.io, 'Name of the copy:', s, defaultName)
          if (name === null) break
          const scope =
            action === 'copy'
              ? location.scope === 'project'
                ? 'global'
                : 'project'
              : location.scope
          const target = uniquePath(configDir(scope, env), validName(name), location.kind)
          if (existsSync(target)) {
            env.log(s.error(`${target} already exists`))
            break
          }
          copyOrWrite(location, target)
          env.log(`${s.success('Created')} ${s.path(target)}`)
          break
        }
        case 'rename': {
          const name = await askText(env.io, 'New name:', s, location.name)
          if (name === null) break
          const target = join(dirname(location.path), `${validName(name)}${extname(location.path)}`)
          if (existsSync(target)) {
            env.log(s.error(`${target} already exists`))
            break
          }
          renameSync(location.path, target)
          env.log(`${s.success('Renamed to')} ${s.path(basename(target))}`)
          break
        }
        case 'delete': {
          const answer = await promptChoice(
            env.io,
            `${s.warn('Delete')} ${s.name(location.name)} ${s.muted(`(${location.path})`)}?`,
            [
              { key: 'y', label: 'delete (keeps a .bak copy)' },
              { key: 'n', label: 'no' },
            ],
            s,
            'n',
          )
          if (answer === 'y') {
            const kept = removeConfigFile(location, false)
            env.log(`${s.success('Deleted.')} ${s.muted(`Backup: ${kept}`)}`)
          }
          break
        }
        default:
          break
      }
    } catch (error) {
      env.log(s.error(error instanceof Error ? error.message : String(error)))
    }
  }
}

export function configPathFor(env: ManageEnv, ref: string): ConfigLocation {
  const discovered = discoverConfigs({
    cwd: env.cwd,
    ...(env.globalDir !== undefined ? { globalDir: env.globalDir } : {}),
  })
  const location = discovered.find((candidate) => candidate.name === ref)
  if (!location) {
    throw new ImageBatchUsageError(
      `no config named "${ref}" — see \`mediatoolz image-batch config list\``,
    )
  }
  return location
}
