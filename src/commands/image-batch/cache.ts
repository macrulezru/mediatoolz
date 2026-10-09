import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface BatchCacheEntry {
  fingerprint: string
  bytes: number
  settingsKey?: string
  hash?: string
}

export interface BatchCache {
  version: 1
  outputs: Record<string, BatchCacheEntry>
}

export function emptyBatchCache(): BatchCache {
  return { version: 1, outputs: {} }
}

export function cacheKeyFor(
  placement: 'out' | 'beside' | 'replace',
  target: string,
  roots: string[],
): string {
  if (placement === 'out') return resolve(target)
  return `${placement}:${roots
    .map((root) => resolve(root))
    .sort()
    .join('|')}`
}

export function defaultCachePath(key: string, baseDir: string = homedir()): string {
  const id = createHash('sha1').update(key.toLowerCase()).digest('hex').slice(0, 16)
  return join(baseDir, '.mediatoolz', 'cache', 'image-batch', `${id}.json`)
}

export function loadBatchCache(path: string): BatchCache {
  if (!existsSync(path)) return emptyBatchCache()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BatchCache
    if (parsed.version !== 1 || typeof parsed.outputs !== 'object' || parsed.outputs === null) {
      return emptyBatchCache()
    }
    return parsed
  } catch {
    return emptyBatchCache()
  }
}

export function saveBatchCache(path: string, cache: BatchCache): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(cache)}\n`)
}
