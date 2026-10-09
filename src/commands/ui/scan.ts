import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { walk } from '../../utils/walk.js'
import { HttpError, asObject, sendJson, type RouteContext } from './http.js'
import { resolveUserPath } from './fs-routes.js'

export interface ScanSource {
  path: string
  exists: boolean
  kind: 'folder' | 'file' | 'missing'
  files: number
  folders: number
  bytes: number
}

export interface ScanResult {
  sources: ScanSource[]
  total: { files: number; folders: number; bytes: number }
}

export function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new HttpError(400, `${name} must be a list of strings`)
  }
  return value as string[]
}

export function scanPaths(
  paths: string[],
  cwd: string,
  extensions: string[],
  recursive: boolean,
): ScanResult {
  const seen = new Map<string, number>()
  const sources: ScanSource[] = []
  for (const path of paths) {
    const abs = resolveUserPath(path, cwd)
    const stat = statSync(abs, { throwIfNoEntry: false })
    if (!stat) {
      sources.push({ path, exists: false, kind: 'missing', files: 0, folders: 0, bytes: 0 })
      continue
    }
    const files = walk([abs], { cwd, extensions, recursive })
    const directories = new Set<string>()
    let bytes = 0
    for (const file of files) {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
      bytes += size
      directories.add(dirname(file))
      seen.set(file, size)
    }
    sources.push({
      path,
      exists: true,
      kind: stat.isDirectory() ? 'folder' : 'file',
      files: files.length,
      folders: directories.size,
      bytes,
    })
  }
  const allFolders = new Set([...seen.keys()].map((file) => dirname(file)))
  return {
    sources,
    total: {
      files: seen.size,
      folders: allFolders.size,
      bytes: [...seen.values()].reduce((sum, size) => sum + size, 0),
    },
  }
}

export function scanHandler(extensions: string[]) {
  return async (ctx: RouteContext): Promise<void> => {
    const body = asObject(await ctx.readBody())
    const paths = stringList(body.paths, 'paths')
    sendJson(ctx.res, 200, scanPaths(paths, ctx.server.cwd, extensions, body.recursive === true))
  }
}
