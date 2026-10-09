import { resolve } from 'node:path'
import {
  OUTPUT_FORMATS,
  QUALITY_LEVELS,
  normalizeFormat,
  validateQualityInput,
  type QualityInput,
} from '../../image-batch/codecs.js'
import {
  METADATA_MODES,
  POSITIONS,
  discoverConfigs,
  emptyConfig,
  loadConfig,
  parseByteSize,
  resolveConfigRef,
  type BatchConfig,
} from '../../image-batch/config.js'
import { ImageBatchUsageError } from '../../image-batch/errors.js'
import { FIT_MODES, type Fit } from '../../image-batch/geometry.js'
import { BATCH_IMAGE_EXTENSIONS } from '../../image-batch/inputs.js'
import {
  runImageBatch,
  type BatchOverrides,
  type ImageBatchOptions,
} from '../../image-batch/run.js'
import {
  SHARPEN_AMOUNTS,
  SHARPEN_FINE_KEYS,
  SHARPEN_RANGES,
  SHARPEN_TARGETS,
  parseSharpenLayer,
} from '../../image-batch/sharpen.js'
import { BUILT_IN_SHARPEN_PRESETS } from '../../image-batch/sharpen-presets.js'
import { TEMPLATE_VARIABLES, defaultTemplate } from '../../image-batch/template.js'
import { loadSharp } from '../../image-hash/sharp-loader.js'
import { withUpperCaseVariants } from '../../image-hash/core.js'
import { findSharp, forgetSharp } from '../fs-routes.js'
import {
  HttpError,
  asObject,
  sendJson,
  type Route,
  type RouteContext,
  type UiModule,
} from '../http.js'
import { startJob } from '../jobs.js'
import { scanHandler, stringList } from '../scan.js'
import { backupRoutes } from './image-batch-backups.js'
import { manageRoutes } from './image-batch-manage.js'

const SIZE_METHODS = [
  'widths',
  'heights',
  'size',
  'longEdge',
  'shortEdge',
  'megapixels',
  'percent',
  'original',
] as const
type SizeMethod = (typeof SIZE_METHODS)[number]

const PLACEMENTS = ['out', 'beside', 'replace'] as const
const OVERWRITE_MODES = ['overwrite', 'skip', 'error'] as const

function usage<T>(task: () => T): T {
  try {
    return task()
  } catch (error) {
    if (error instanceof ImageBatchUsageError) throw new HttpError(400, error.message)
    throw error
  }
}

function numberList(value: unknown, name: string, min: number, max: number, whole: boolean) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, `${name}: give at least one number`)
  }
  const numbers = value.map(Number)
  if (
    numbers.some(
      (n) => !Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n)),
    )
  ) {
    throw new HttpError(
      400,
      `${name}: expected ${whole ? 'whole numbers' : 'numbers'} from ${min} to ${max}`,
    )
  }
  return numbers
}

function overridesFrom(settings: Record<string, unknown>): BatchOverrides | undefined {
  const overrides: BatchOverrides = {}
  const method = (settings.sizeMethod ?? 'original') as SizeMethod
  if (!SIZE_METHODS.includes(method))
    throw new HttpError(400, `sizeMethod: expected one of ${SIZE_METHODS.join(', ')}`)
  if (method === 'widths') overrides.widths = numberList(settings.values, 'widths', 1, 65535, true)
  if (method === 'heights')
    overrides.heights = numberList(settings.values, 'heights', 1, 65535, true)
  if (method === 'longEdge')
    overrides.longEdge = numberList(settings.values, 'long side', 1, 65535, true)
  if (method === 'shortEdge')
    overrides.shortEdge = numberList(settings.values, 'short side', 1, 65535, true)
  if (method === 'megapixels')
    overrides.megapixels = numberList(settings.values, 'megapixels', 0.001, 1000, false)
  if (method === 'percent')
    overrides.percent = numberList(settings.values, 'percent', 0.1, 1000, false)
  if (method === 'size') {
    if (typeof settings.box !== 'string')
      throw new HttpError(400, 'box: give a size like 1920x1080')
    overrides.size = settings.box
    if (settings.matchOrientation === true) overrides.matchOrientation = true
    if (typeof settings.fit === 'string') {
      if (!(FIT_MODES as readonly string[]).includes(settings.fit)) {
        throw new HttpError(400, `fit: expected one of ${FIT_MODES.join(', ')}`)
      }
      overrides.fit = settings.fit as Fit
    }
  }
  if (settings.formats !== undefined) {
    const formats = stringList(settings.formats, 'formats')
    if (formats.length === 0) throw new HttpError(400, 'formats: pick at least one format')
    usage(() => formats.forEach((format) => normalizeFormat(format, 'formats')))
    overrides.formats = formats
  }
  if (settings.quality !== undefined && settings.quality !== null && settings.quality !== '') {
    const quality = usage(() => validateQualityInput(settings.quality, 'quality')) as QualityInput
    overrides.quality = quality
  }
  if (settings.maxBytes !== undefined && settings.maxBytes !== null && settings.maxBytes !== '') {
    overrides.maxBytes = usage(() => parseByteSize(settings.maxBytes, 'max size'))
  }
  if (typeof settings.name === 'string' && settings.name.trim() !== '')
    overrides.name = settings.name.trim()
  if (settings.sharpen !== undefined && settings.sharpen !== null) {
    overrides.sharpen = usage(() => parseSharpenLayer(settings.sharpen, 'sharpen'))
  }
  if (settings.flatten === true || typeof settings.flatten === 'string') {
    overrides.flatten = settings.flatten as boolean | string
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

async function configFor(
  name: string | undefined,
  cwd: string,
): Promise<{ config: BatchConfig; label?: string }> {
  if (name === undefined || name === '') return { config: emptyConfig() }
  const location = usage(() => resolveConfigRef(name, discoverConfigs({ cwd }), cwd))
  const loaded = await usage(() => loadConfig(location))
  return { config: loaded.config, label: location.name }
}

async function startRun(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const cwd = ctx.server.cwd
  const paths = stringList(body.paths, 'paths')
  if (paths.length === 0) throw new HttpError(400, 'add at least one folder or image')
  const placement = (body.placement ?? 'out') as (typeof PLACEMENTS)[number]
  if (!PLACEMENTS.includes(placement)) throw new HttpError(400, 'placement: out, beside or replace')
  const overwrite = (body.overwrite ?? 'skip') as (typeof OVERWRITE_MODES)[number]
  if (!OVERWRITE_MODES.includes(overwrite)) {
    throw new HttpError(400, `overwrite: expected one of ${OVERWRITE_MODES.join(', ')}`)
  }
  if (placement === 'out' && (typeof body.out !== 'string' || body.out.trim() === '')) {
    throw new HttpError(400, 'choose the folder for the results')
  }
  const out =
    typeof body.out === 'string' && body.out.trim() !== ''
      ? resolve(cwd, body.out.trim())
      : undefined
  const settings = body.settings === undefined ? {} : asObject(body.settings, 'settings')
  const overrides = body.config ? undefined : overridesFrom(settings)
  const loaded = await configFor(typeof body.config === 'string' ? body.config : undefined, cwd)
  const dryRun = body.dryRun === true
  const installSharp = body.installSharp === true

  const id = startJob(async (progress) => {
    if (installSharp) await loadSharp({ assumeYes: true, cwd, command: 'image-batch' })
    const options: ImageBatchOptions = {
      paths: paths.map((path) => resolve(cwd, path)),
      cwd,
      config: loaded.config,
      recursive: body.recursive === true,
      overwrite,
      dryRun,
      assumeYes: true,
      interactive: false,
      concurrency: 4,
      onProgress: progress,
    }
    if (loaded.label !== undefined) options.configLabel = loaded.label
    if (overrides) options.overrides = overrides
    if (placement === 'out' && out) options.out = out
    if (placement === 'out' && body.flat === true) options.flat = true
    if (placement === 'beside') options.beside = true
    if (placement === 'replace') {
      options.replace = true
      if (body.backup === false) options.backup = false
      if (body.onlyIfSmaller === false) options.onlyIfSmaller = false
    }
    const report = await runImageBatch(options)
    forgetSharp()
    return report
  })
  sendJson(ctx.res, 202, { jobId: id })
}

const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/image-batch/options',
    handler: ({ res, server }) => {
      sendJson(res, 200, {
        formats: [...OUTPUT_FORMATS, 'original'],
        qualityLevels: QUALITY_LEVELS,
        sizeMethods: SIZE_METHODS,
        fitModes: FIT_MODES,
        positions: POSITIONS,
        metadataModes: METADATA_MODES,
        placements: PLACEMENTS,
        overwriteModes: OVERWRITE_MODES,
        sharpen: {
          targets: SHARPEN_TARGETS,
          amounts: SHARPEN_AMOUNTS,
          fine: SHARPEN_FINE_KEYS.map((key) => ({ key, range: SHARPEN_RANGES[key] })),
          builtIn: Object.keys(BUILT_IN_SHARPEN_PRESETS),
        },
        templateVariables: TEMPLATE_VARIABLES,
        defaultTemplates: {
          original: defaultTemplate({}),
          widths: defaultTemplate({ widths: true }),
          heights: defaultTemplate({ heights: true }),
          size: defaultTemplate({ size: true }),
          longEdge: defaultTemplate({ longEdge: true }),
          shortEdge: defaultTemplate({ shortEdge: true }),
          megapixels: defaultTemplate({ megapixels: true }),
          percent: defaultTemplate({ percent: true }),
        },
        sharp: findSharp(server.cwd) !== null,
      })
    },
  },
  {
    method: 'POST',
    path: '/api/image-batch/scan',
    handler: scanHandler(withUpperCaseVariants(BATCH_IMAGE_EXTENSIONS)),
  },
  ...manageRoutes,
  ...backupRoutes,
  { method: 'POST', path: '/api/image-batch/run', handler: startRun },
]

export const imageBatchModule: UiModule = {
  id: 'image-batch',
  title: 'Image Batch',
  description: 'Resize, convert and sharpen images in bulk by saved rules.',
  status: 'available',
  routes,
}
