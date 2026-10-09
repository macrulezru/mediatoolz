import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  discoverConfigs,
  parseConfig,
  readConfigSource,
  type ConfigLocation,
} from '../../image-batch/config.js'
import { ImageBatchUsageError } from '../../image-batch/errors.js'
import {
  configDir,
  describeConfigLines,
  describeLocation,
  removeConfigFile,
  validName,
  writeJson,
} from '../../image-batch/manage.js'
import {
  completeSharpen,
  parseSharpenFields,
  sharpenParams,
  type SharpenFields,
} from '../../image-batch/sharpen.js'
import {
  attachSharpenPresets,
  discoverSharpenPresets,
  readSharpenPreset,
  type SharpenPresetLocation,
} from '../../image-batch/sharpen-presets.js'
import { removeSharpenPreset, sharpenDir } from '../../image-batch/sharpen-manage.js'
import { findSharp, resolveUserPath } from '../fs-routes.js'
import { HttpError, asObject, sendBytes, sendJson, type Route, type RouteContext } from '../http.js'

type Scope = 'project' | 'global'

function usage<T>(task: () => T): T {
  try {
    return task()
  } catch (error) {
    if (error instanceof ImageBatchUsageError) throw new HttpError(400, error.message)
    throw error
  }
}

function scopeOf(value: unknown): Scope {
  if (value === 'project' || value === 'global') return value
  throw new HttpError(400, 'scope must be "project" or "global"')
}

function nameOf(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'give a name')
  return usage(() => validName(value))
}

function findConfig(ctx: RouteContext, name: string, scope: Scope): ConfigLocation {
  const found = discoverConfigs({ cwd: ctx.server.cwd }).find(
    (location) => location.name === name && location.scope === scope,
  )
  if (!found) throw new HttpError(404, `no ${scope} config named "${name}"`)
  return found
}

function validateRaw(
  raw: unknown,
  cwd: string,
): { config: ReturnType<typeof parseConfig>; lines: string[] } {
  const parsed = usage(() => parseConfig(raw, 'config'))
  const config = usage(() => attachSharpenPresets(parsed, { cwd }))
  const lines = describeConfigLines(config, { plain: true })
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
  return { config, lines }
}

async function readConfig(ctx: RouteContext): Promise<void> {
  const name = nameOf(ctx.url.searchParams.get('name'))
  const scope = scopeOf(ctx.url.searchParams.get('scope'))
  const location = findConfig(ctx, name, scope)
  if (!location.editable) {
    throw new HttpError(
      422,
      `${location.name} is a .${location.kind} file — only .json configs can be edited here`,
    )
  }
  const raw = await readConfigSource(location)
  sendJson(ctx.res, 200, { name, scope, path: location.path, raw })
}

async function validateConfig(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  try {
    const { lines } = validateRaw(body.raw, ctx.server.cwd)
    sendJson(ctx.res, 200, { ok: true, lines })
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      sendJson(ctx.res, 200, { ok: false, error: error.message })
      return
    }
    throw error
  }
}

async function saveConfig(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const name = nameOf(body.name)
  const scope = scopeOf(body.scope)
  validateRaw(body.raw, ctx.server.cwd)
  const env = { cwd: ctx.server.cwd }
  const path = join(configDir(scope, env), `${name}.json`)
  const original =
    typeof body.originalName === 'string' && body.originalScope !== undefined
      ? { name: body.originalName, scope: scopeOf(body.originalScope) }
      : undefined
  const sameAsOriginal = original?.name === name && original.scope === scope
  if (existsSync(path) && !sameAsOriginal && body.overwrite !== true) {
    sendJson(ctx.res, 409, { error: `${path} already exists`, exists: true, path })
    return
  }
  const clash = discoverConfigs({ cwd: ctx.server.cwd }).find(
    (location) => location.name === name && location.scope === scope && location.kind !== 'json',
  )
  if (clash) throw new HttpError(409, `${clash.path} already exists and is not a JSON file`)
  writeJson(path, body.raw)
  if (original && !sameAsOriginal) {
    const old = discoverConfigs({ cwd: ctx.server.cwd }).find(
      (location) => location.name === original.name && location.scope === original.scope,
    )
    if (old && old.path !== path) removeConfigFile(old, true)
  }
  sendJson(ctx.res, 200, { name, scope, path })
}

async function deleteConfig(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const location = findConfig(ctx, nameOf(body.name), scopeOf(body.scope))
  const backup = removeConfigFile(location, false)
  sendJson(ctx.res, 200, { deleted: location.path, backup })
}

async function listConfigs(ctx: RouteContext): Promise<void> {
  const locations = discoverConfigs({ cwd: ctx.server.cwd })
  const rows = await Promise.all(locations.map(describeLocation))
  sendJson(
    ctx.res,
    200,
    rows.map((row) => ({
      name: row.location.name,
      scope: row.location.scope,
      path: row.location.path,
      kind: row.location.kind,
      editable: row.location.editable,
      title: row.title,
      description: row.description,
      recipes: row.recipes,
      rules: row.rules,
      error: row.error,
    })),
  )
}

function presetRow(location: SharpenPresetLocation) {
  try {
    const preset = readSharpenPreset(location)
    return {
      name: location.name,
      scope: location.scope,
      path: location.path,
      description: preset.description,
      fields: preset.fields,
      params: sharpenParams(completeSharpen(preset.fields)),
    }
  } catch (error) {
    return {
      name: location.name,
      scope: location.scope,
      path: location.path,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function listPresets(ctx: RouteContext): void {
  sendJson(
    ctx.res,
    200,
    discoverSharpenPresets({ cwd: ctx.server.cwd }).map((location) => presetRow(location)),
  )
}

function fieldsFrom(value: unknown, allowEmpty = false): SharpenFields {
  const object = asObject(value, 'fields')
  const { preset: _preset, ...rest } = object
  void _preset
  if (Object.keys(rest).length === 0) {
    if (allowEmpty) return {}
    throw new HttpError(400, 'choose at least one setting: a target, an amount or a fine value')
  }
  return usage(() => parseSharpenFields(rest, 'sharpen', false))
}

async function previewParams(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const fields = fieldsFrom(body.fields, true)
  sendJson(ctx.res, 200, { params: sharpenParams(completeSharpen(fields)) })
}

async function savePreset(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const name = nameOf(body.name)
  const scope = scopeOf(body.scope)
  const fields = fieldsFrom(body.fields)
  const description =
    typeof body.description === 'string' && body.description.trim() !== ''
      ? body.description.trim()
      : undefined
  const path = join(sharpenDir(scope, { cwd: ctx.server.cwd }), `${name}.json`)
  const original =
    typeof body.originalName === 'string' && body.originalScope !== undefined
      ? { name: body.originalName, scope: scopeOf(body.originalScope) }
      : undefined
  const same = original?.name === name && original.scope === scope
  if (existsSync(path) && !same && body.overwrite !== true) {
    sendJson(ctx.res, 409, { error: `${path} already exists`, exists: true, path })
    return
  }
  writeJson(path, { ...(description ? { description } : {}), ...fields })
  if (original && !same) {
    const old = discoverSharpenPresets({ cwd: ctx.server.cwd }).find(
      (location) =>
        location.name === original.name &&
        location.scope === original.scope &&
        location.path !== path,
    )
    if (old) removeSharpenPreset(old, true)
  }
  sendJson(ctx.res, 200, { name, scope, path })
}

async function deletePreset(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const name = nameOf(body.name)
  const scope = scopeOf(body.scope)
  const location = discoverSharpenPresets({ cwd: ctx.server.cwd }).find(
    (candidate) => candidate.name === name && candidate.scope === scope,
  )
  if (!location) throw new HttpError(404, `no ${scope} sharpen preset named "${name}"`)
  const backup = usage(() => removeSharpenPreset(location, false))
  sendJson(ctx.res, 200, { deleted: location.path, backup })
}

async function sharpenPreview(ctx: RouteContext): Promise<void> {
  const { url, res, server } = ctx
  const path = resolveUserPath(url.searchParams.get('path'), server.cwd)
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, 'no such file')
  const sharp = findSharp(server.cwd)
  if (!sharp) throw new HttpError(503, 'the sharp library is not installed')
  const width = Math.min(Math.max(Number(url.searchParams.get('width') ?? 800) || 800, 16), 3000)
  const raw: Record<string, unknown> = {}
  for (const key of ['for', 'amount']) {
    const value = url.searchParams.get(key)
    if (value) raw[key] = value
  }
  for (const key of ['radius', 'flat', 'jagged', 'threshold']) {
    const value = url.searchParams.get(key)
    if (value !== null && value !== '') raw[key] = Number(value)
  }
  const apply = url.searchParams.get('sharpen') === '1'
  const fields = apply ? fieldsFrom(raw, true) : undefined
  try {
    let image = sharp(path, { failOn: 'none' })
      .rotate()
      .resize({ width, height: width * 4, fit: 'inside', withoutEnlargement: true }) as unknown as {
      sharpen: (options: unknown) => unknown
      webp: (options: unknown) => { toBuffer: () => Promise<Uint8Array> }
    }
    if (fields) image = image.sharpen(sharpenParams(completeSharpen(fields))) as typeof image
    const bytes = await image.webp({ quality: 92 }).toBuffer()
    sendBytes(res, 'image/webp', bytes)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(422, 'this image could not be read')
  }
}

export const manageRoutes: Route[] = [
  { method: 'GET', path: '/api/image-batch/configs', handler: listConfigs },
  { method: 'GET', path: '/api/image-batch/config', handler: readConfig },
  { method: 'POST', path: '/api/image-batch/config/validate', handler: validateConfig },
  { method: 'POST', path: '/api/image-batch/config/save', handler: saveConfig },
  { method: 'POST', path: '/api/image-batch/config/delete', handler: deleteConfig },
  { method: 'GET', path: '/api/image-batch/sharpen-presets', handler: listPresets },
  { method: 'POST', path: '/api/image-batch/sharpen-preset/params', handler: previewParams },
  { method: 'POST', path: '/api/image-batch/sharpen-preset/save', handler: savePreset },
  { method: 'POST', path: '/api/image-batch/sharpen-preset/delete', handler: deletePreset },
  { method: 'GET', path: '/api/image-batch/sharpen-preview', handler: sharpenPreview },
]
