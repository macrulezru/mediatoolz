import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { didYouMean } from '../../utils/closest.js'
import { CONFIG_DIR_SEGMENTS, globalConfigDir, type BatchConfig } from './config.js'
import { ImageBatchUsageError } from './errors.js'
import { parseSharpenFields, type SharpenFields, type SharpenLayer } from './sharpen.js'

export const SHARPEN_DIR_NAME = 'sharpen'

export interface SharpenPresetLocation {
  name: string
  path: string
  scope: 'project' | 'global' | 'built-in'
}

export interface SharpenPreset {
  description?: string
  fields: SharpenFields
}

export interface SharpenDiscoverOptions {
  cwd: string
  globalDir?: string
}

export const BUILT_IN_SHARPEN_PRESETS: Record<string, SharpenPreset> = {
  'web-light': {
    description: 'A light touch for web photos',
    fields: { for: 'screen', amount: 'low' },
  },
  'web-crisp': {
    description: 'Everyday sharpening for the web',
    fields: { for: 'screen', amount: 'standard' },
  },
  'web-detail': {
    description: 'Fine detail for large web photos',
    fields: { for: 'screen', amount: 'high', radius: 0.8 },
  },
  thumbnail: {
    description: 'Small previews: a fine radius, gentle on flat areas',
    fields: { for: 'screen', amount: 'standard', radius: 0.4, flat: 0.6, jagged: 2.5 },
  },
  'print-matte': {
    description: 'Matte paper',
    fields: { for: 'matte', amount: 'standard' },
  },
  'print-glossy': {
    description: 'Glossy paper',
    fields: { for: 'glossy', amount: 'standard' },
  },
}

export function globalSharpenDir(globalDir?: string): string {
  return join(globalDir ?? globalConfigDir(homedir()), SHARPEN_DIR_NAME)
}

function listPresets(dir: string, scope: SharpenPresetLocation['scope']): SharpenPresetLocation[] {
  const stat = statSync(dir, { throwIfNoEntry: false })
  if (!stat?.isDirectory()) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.json')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: basename(entry.name, extname(entry.name)),
      path: join(dir, entry.name),
      scope,
    }))
}

export function discoverSharpenPresets(options: SharpenDiscoverOptions): SharpenPresetLocation[] {
  const found: SharpenPresetLocation[] = []
  const seen = new Set<string>()
  const globalDir = resolve(globalSharpenDir(options.globalDir))
  const homeGlobalDir = resolve(globalSharpenDir())
  let dir = resolve(options.cwd)
  for (;;) {
    const candidate = join(dir, ...CONFIG_DIR_SEGMENTS, SHARPEN_DIR_NAME)
    const resolved = resolve(candidate)
    if (resolved !== globalDir && resolved !== homeGlobalDir && !seen.has(candidate)) {
      seen.add(candidate)
      found.push(...listPresets(candidate, 'project'))
    }
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  found.push(...listPresets(globalDir, 'global'))
  const own = new Set(found.map((location) => location.name))
  for (const name of Object.keys(BUILT_IN_SHARPEN_PRESETS)) {
    if (!own.has(name)) found.push({ name, path: `(built-in ${name})`, scope: 'built-in' })
  }
  return found
}

export function readSharpenPreset(location: SharpenPresetLocation): SharpenPreset {
  if (location.scope === 'built-in') {
    const preset = BUILT_IN_SHARPEN_PRESETS[location.name]
    if (!preset) throw new ImageBatchUsageError(`${location.name} is not a built-in preset`)
    return preset
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(location.path, 'utf8'))
  } catch (error) {
    throw new ImageBatchUsageError(
      `${location.path}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ImageBatchUsageError(`${location.path}: expected a JSON object`)
  }
  const { description, ...rest } = parsed as Record<string, unknown>
  if (description !== undefined && typeof description !== 'string') {
    throw new ImageBatchUsageError(`${location.path}.description: expected a string`)
  }
  const fields = parseSharpenFields(rest, location.path, false)
  return { ...(description !== undefined ? { description } : {}), fields }
}

export function findSharpenPreset(
  name: string,
  discovered: SharpenPresetLocation[],
): SharpenPresetLocation {
  const matches = discovered.filter((location) => location.name === name)
  const chosen = matches.find((match) => match.scope === 'project') ?? matches[0]
  if (!chosen) {
    const names = [...new Set(discovered.map((location) => location.name))]
    throw new ImageBatchUsageError(
      `no sharpen preset named "${name}".${didYouMean(name, names)} ${
        names.length > 0
          ? `Available: ${names.join(', ')}.`
          : 'None found — create one with `mediatoolz image-batch sharpen new`.'
      }`,
    )
  }
  return chosen
}

function layersOf(config: BatchConfig, extra: (SharpenLayer | undefined)[]): SharpenLayer[] {
  const recipes = [
    config.defaults,
    ...Object.values(config.presets),
    ...config.outputs,
    ...config.match.flatMap((rule) => rule.outputs),
  ]
  const layers: SharpenLayer[] = []
  for (const recipe of recipes) if (recipe.sharpen) layers.push(recipe.sharpen)
  for (const layer of extra) if (layer) layers.push(layer)
  return layers
}

export function attachSharpenPresets(
  config: BatchConfig,
  options: SharpenDiscoverOptions & { extra?: (SharpenLayer | undefined)[] },
): BatchConfig {
  const names = [
    ...new Set(
      layersOf(config, options.extra ?? [])
        .map((layer) => layer.preset)
        .filter((name): name is string => name !== undefined),
    ),
  ]
  if (names.length === 0) return config
  const discovered = discoverSharpenPresets(options)
  const presets: Record<string, SharpenFields> = {}
  for (const name of names) {
    presets[name] = readSharpenPreset(findSharpenPreset(name, discovered)).fields
  }
  return { ...config, sharpenPresets: presets }
}
