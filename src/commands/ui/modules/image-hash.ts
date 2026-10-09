import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  ALL_TYPES,
  DEFAULT_BLURHASH_COMPONENTS,
  DEFAULT_EXPORT_NAME,
  DEFAULT_HAZEHASH_BUDGET,
  DEFAULT_IMAGE_EXTENSIONS,
  ImageHashUsageError,
  MAX_HAZEHASH_BUDGET,
  MIN_HAZEHASH_BUDGET,
  OUTPUT_FORMATS,
  parseBudget,
  parseComponents,
  parseFormat,
  parseTypes,
  validateExportName,
  withUpperCaseVariants,
  type HashEntry,
} from '../../image-hash/core.js'
import { runImageHash } from '../../image-hash/run.js'
import { forgetSharp, findSharp, resolveUserPath } from '../fs-routes.js'
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

const TYPE_INFO: Record<string, { title: string; description: string }> = {
  hazehash: {
    title: 'Hazehash',
    description:
      'A compact placeholder (7–48 bytes) that keeps the aspect ratio and, when needed, alpha.',
  },
  blurhash: {
    title: 'Blurhash',
    description: 'A short string that decodes to a blurred preview.',
  },
  thumbhash: {
    title: 'Thumbhash',
    description: 'A blurred preview that also keeps the aspect ratio and transparency.',
  },
  color: { title: 'Dominant color', description: 'The most common color as #rrggbb.' },
  preview: { title: 'Tiny preview', description: 'A very small PNG as a data URI.' },
}

function usage<T>(task: () => T): T {
  try {
    return task()
  } catch (error) {
    if (error instanceof ImageHashUsageError) throw new HttpError(400, error.message)
    throw error
  }
}

function baseOf(paths: string[], cwd: string): string {
  const first = paths[0]
  if (first === undefined) return cwd
  const abs = resolveUserPath(first, cwd)
  const stat = statSync(abs, { throwIfNoEntry: false })
  return stat?.isDirectory() ? abs : dirname(abs)
}

async function startRun(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const cwd = ctx.server.cwd
  const paths = stringList(body.paths, 'paths')
  if (paths.length === 0) throw new HttpError(400, 'add at least one folder or image')
  const types = usage(() => parseTypes(stringList(body.types ?? ['both'], 'types').join(',')))
  const components =
    typeof body.components === 'string'
      ? usage(() => parseComponents(body.components as string))
      : undefined
  const budget =
    body.budget !== undefined ? usage(() => parseBudget(String(body.budget))) : undefined
  const format = usage(() => parseFormat(typeof body.format === 'string' ? body.format : 'json'))
  const exportName = usage(() =>
    validateExportName(typeof body.exportName === 'string' ? body.exportName : DEFAULT_EXPORT_NAME),
  )
  const ignoreGlobs =
    body.ignoreGlobs !== undefined ? stringList(body.ignoreGlobs, 'ignoreGlobs') : []
  const base = baseOf(paths, cwd)
  const installSharp = body.installSharp === true

  const id = startJob(async (progress) => {
    try {
      const report = await runImageHash({
        paths: paths.map((path) => resolveUserPath(path, cwd)),
        cwd,
        types,
        recursive: body.recursive === true,
        ...(components ? { components } : {}),
        ...(budget !== undefined ? { budget } : {}),
        format,
        exportName,
        keyBase: base,
        ignoreGlobs,
        assumeYes: installSharp,
        concurrency: 4,
        onProgress: progress,
      })
      forgetSharp()
      const entries = report.entries.map((entry: HashEntry) => ({
        ...entry,
        path: resolve(base, entry.file),
      }))
      return {
        base,
        filesScanned: report.filesScanned,
        cached: report.cached,
        errors: report.errors,
        entries,
        output: report.stdout,
        format,
        exitCode: report.exitCode,
      }
    } catch (error) {
      if (error instanceof ImageHashUsageError) {
        throw new Error(error.message, { cause: error })
      }
      throw error
    }
  })
  sendJson(ctx.res, 202, { jobId: id })
}

async function saveOutput(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  if (typeof body.path !== 'string' || body.path.trim() === '') {
    throw new HttpError(400, 'give a file path')
  }
  if (typeof body.content !== 'string') throw new HttpError(400, 'content must be a string')
  const path = resolveUserPath(body.path, ctx.server.cwd)
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new HttpError(400, `${path} is a folder`)
  }
  if (existsSync(path) && body.overwrite !== true) {
    sendJson(ctx.res, 409, { error: `${path} already exists`, exists: true, path })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body.content)
  sendJson(ctx.res, 200, { path })
}

const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/image-hash/options',
    handler: ({ res, server }) => {
      sendJson(res, 200, {
        types: ALL_TYPES.map((id) => ({ id, ...TYPE_INFO[id] })),
        formats: OUTPUT_FORMATS,
        budget: {
          min: MIN_HAZEHASH_BUDGET,
          max: MAX_HAZEHASH_BUDGET,
          default: DEFAULT_HAZEHASH_BUDGET,
        },
        components: {
          default: `${DEFAULT_BLURHASH_COMPONENTS.x}x${DEFAULT_BLURHASH_COMPONENTS.y}`,
          auto: true,
        },
        exportName: DEFAULT_EXPORT_NAME,
        extensions: DEFAULT_IMAGE_EXTENSIONS,
        sharp: findSharp(server.cwd) !== null,
      })
    },
  },
  { method: 'POST', path: '/api/image-hash/run', handler: startRun },
  {
    method: 'POST',
    path: '/api/image-hash/scan',
    handler: scanHandler(withUpperCaseVariants(DEFAULT_IMAGE_EXTENSIONS)),
  },
  { method: 'POST', path: '/api/image-hash/save', handler: saveOutput },
]

export const imageHashModule: UiModule = {
  id: 'image-hash',
  title: 'Image Hash',
  description: 'Blurhash, thumbhash and hazehash placeholders for your images.',
  status: 'available',
  routes,
}
