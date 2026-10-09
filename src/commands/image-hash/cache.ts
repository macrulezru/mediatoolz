import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ALL_TYPES, type HashType } from './core.js'
import type { ComputedHashes } from './hash.js'

export interface CacheRecord extends ComputedHashes {
  sig: string
  params: string
}

export interface CacheFile {
  version: 1
  files: Record<string, CacheRecord>
}

export function emptyCache(): CacheFile {
  return { version: 1, files: {} }
}

export function loadCache(path: string): CacheFile {
  if (!existsSync(path)) return emptyCache()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile
    if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) {
      return emptyCache()
    }
    return parsed
  } catch {
    return emptyCache()
  }
}

export function saveCache(path: string, cache: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(cache)}\n`)
}

export function cacheHit(
  record: CacheRecord | undefined,
  sig: string,
  params: string,
  types: HashType[],
): ComputedHashes | null {
  if (!record || record.sig !== sig || record.params !== params) return null
  for (const type of types) {
    if (record[type] === undefined) return null
  }
  const hit: ComputedHashes = { width: record.width, height: record.height }
  for (const type of ALL_TYPES) {
    const value = record[type]
    if (value !== undefined) hit[type] = value
  }
  return hit
}
