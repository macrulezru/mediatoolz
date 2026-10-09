import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'
import { DEFAULT_IMAGE_EXTENSIONS } from '../image-hash/core.js'
import { defaultSharpLoaderDeps, type SharpFactory } from '../image-hash/sharp-loader.js'
import { HttpError, sendBytes, sendJson, type Route } from './http.js'

const IMAGE_EXTENSIONS = new Set([...DEFAULT_IMAGE_EXTENSIONS, '.svg'])
const BROWSER_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}
const MAX_ENTRIES = 5000
const MAX_RAW_BYTES = 20 * 1024 * 1024
const SHARP_RETRY_MS = 5000

let sharpCache: { factory: SharpFactory | null; checked: number } | undefined

export function findSharp(cwd: string): SharpFactory | null {
  if (sharpCache?.factory) return sharpCache.factory
  if (sharpCache && Date.now() - sharpCache.checked < SHARP_RETRY_MS) return null
  const deps = defaultSharpLoaderDeps()
  const factory = deps.resolveBundled() ?? deps.resolveFromCwd(cwd) ?? deps.resolveManaged()
  sharpCache = { factory, checked: Date.now() }
  return factory
}

export function forgetSharp(): void {
  sharpCache = undefined
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

function roots(): string[] {
  if (process.platform !== 'win32') return ['/']
  const found: string[] = []
  for (let code = 65; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:\\`
    if (existsSync(drive)) found.push(drive)
  }
  return found
}

export function resolveUserPath(raw: string | null, fallback: string): string {
  if (raw === null || raw.trim() === '') return fallback
  const path = raw.trim()
  return isAbsolute(path) ? resolve(path) : resolve(fallback, path)
}

export const fsRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/fs/list',
    handler: ({ res, url, server }) => {
      const path = resolveUserPath(url.searchParams.get('path'), server.cwd)
      const showHidden = url.searchParams.get('hidden') === '1'
      const stat = statSync(path, { throwIfNoEntry: false })
      if (!stat?.isDirectory()) throw new HttpError(404, `${path} is not a folder`)
      let names: import('node:fs').Dirent[]
      try {
        names = readdirSync(path, { withFileTypes: true })
      } catch (error) {
        throw new HttpError(403, error instanceof Error ? error.message : String(error))
      }
      const folders: { name: string; kind: 'dir' }[] = []
      const images: { name: string; kind: 'image'; size: number }[] = []
      for (const entry of names) {
        if (!showHidden && entry.name.startsWith('.')) continue
        if (entry.isDirectory()) folders.push({ name: entry.name, kind: 'dir' })
        else if (entry.isFile() && isImagePath(entry.name)) {
          const size = statSync(join(path, entry.name), { throwIfNoEntry: false })?.size ?? 0
          images.push({ name: entry.name, kind: 'image', size })
        }
      }
      folders.sort((a, b) => a.name.localeCompare(b.name))
      images.sort((a, b) => a.name.localeCompare(b.name))
      const entries = [...folders, ...images]
      const parent = dirname(path)
      sendJson(res, 200, {
        path,
        parent: parent === path ? null : parent,
        home: homedir(),
        cwd: server.cwd,
        root: parse(path).root,
        roots: roots(),
        entries: entries.slice(0, MAX_ENTRIES),
        truncated: entries.length > MAX_ENTRIES,
      })
    },
  },
  {
    method: 'GET',
    path: '/api/fs/image',
    handler: async ({ res, url, server }) => {
      const path = resolveUserPath(url.searchParams.get('path'), server.cwd)
      if (!isImagePath(path)) throw new HttpError(400, 'not an image file')
      const stat = statSync(path, { throwIfNoEntry: false })
      if (!stat?.isFile()) throw new HttpError(404, 'no such file')
      const requested = Number(url.searchParams.get('size') ?? 0)
      const size = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 2000) : 0
      const sharp = findSharp(server.cwd)
      if (sharp && size > 0) {
        try {
          const bytes = await sharp(path, { failOn: 'none' })
            .rotate()
            .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 78 })
            .toBuffer()
          sendBytes(res, 'image/webp', bytes, 'private, max-age=60')
          return
        } catch {
          throw new HttpError(422, 'this image could not be read')
        }
      }
      const type = BROWSER_TYPES[extname(path).toLowerCase()]
      if (!type) throw new HttpError(415, 'this format needs sharp for a preview')
      if (stat.size > MAX_RAW_BYTES) throw new HttpError(413, 'too large to preview without sharp')
      sendBytes(res, type, readFileSync(path), 'private, max-age=60')
    },
  },
]
