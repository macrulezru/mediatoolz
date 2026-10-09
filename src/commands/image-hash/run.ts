import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { walk } from '../../utils/walk.js'
import {
  ALL_TYPES,
  DEFAULT_BLURHASH_COMPONENTS,
  DEFAULT_HAZEHASH_BUDGET,
  DEFAULT_EXPORT_NAME,
  DEFAULT_IMAGE_EXTENSIONS,
  DEFAULT_SAMPLE_SIZE,
  ImageHashUsageError,
  componentsLabel,
  formatAggregate,
  formatPerFile,
  isUrl,
  normalizeOutExtension,
  orderTypes,
  outputFileName,
  parseAggregate,
  splitPathArguments,
  validateExportName,
  validateSuffix,
  withUpperCaseVariants,
  type Components,
  type HashEntry,
  type HashType,
  type OutputFormat,
} from './core.js'
import { cacheHit, emptyCache, loadCache, saveCache, type CacheRecord } from './cache.js'
import { computeHashes, friendlyMessage, type ComputedHashes } from './hash.js'
import { loadSharp, type SharpFactory } from './sharp-loader.js'

const DOWNLOAD_TIMEOUT_MS = 30000
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

export interface ImageHashProgress {
  done: number
  total: number
  cached: number
}

export interface ImageHashRunOptions {
  paths: string[]
  cwd: string
  types: HashType[]
  recursive?: boolean
  extensions?: string[]
  ignoreGlobs?: string[]
  respectGitignore?: boolean
  components?: Components
  budget?: number
  size?: number
  maxPixels?: number
  format?: OutputFormat
  exportName?: string
  out?: string
  perFile?: boolean
  outDir?: string
  suffix?: string
  outExtension?: string
  keyBase?: string
  keyPrefix?: string
  cache?: string
  update?: boolean
  prune?: boolean
  check?: boolean
  concurrency?: number
  assumeYes?: boolean
  dryRun?: boolean
  sharp?: SharpFactory
  onProgress?: (progress: ImageHashProgress) => void
}

export interface ImageHashError {
  file: string
  message: string
}

export interface OutdatedOutput {
  file: string
  reason: 'missing' | 'changed'
}

export interface ImageHashReport {
  filesScanned: number
  entries: HashEntry[]
  written: string[]
  errors: ImageHashError[]
  stdout: string | null
  dryRun: boolean
  check: boolean
  checked: number
  outdated: OutdatedOutput[]
  cached: number
  pruned: number
  exitCode: number
}

interface SourceImage {
  abs: string
  root: string
  url: boolean
}

interface PlannedOutput {
  path: string
  content: string
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

function urlBaseName(url: string): string {
  try {
    const name = basename(decodeURIComponent(new URL(url).pathname))
    return name === '' ? 'image' : name
  } catch {
    return 'image'
  }
}

function collectImages(options: ImageHashRunOptions, errors: ImageHashError[]): SourceImage[] {
  const extensions = withUpperCaseVariants(options.extensions ?? DEFAULT_IMAGE_EXTENSIONS)
  const images: SourceImage[] = []
  const seen = new Set<string>()

  for (const input of splitPathArguments(options.paths)) {
    if (isUrl(input)) {
      if (!seen.has(input)) {
        seen.add(input)
        images.push({ abs: input, root: '', url: true })
      }
      continue
    }
    const abs = resolve(options.cwd, input)
    const stat = statSync(abs, { throwIfNoEntry: false })
    if (!stat) {
      errors.push({ file: input, message: 'path does not exist' })
      continue
    }
    const root = stat.isDirectory() ? abs : dirname(abs)
    const found = walk([abs], {
      cwd: options.cwd,
      extensions,
      ignoreGlobs: options.ignoreGlobs ?? [],
      recursive: options.recursive ?? false,
      ...(options.respectGitignore !== undefined
        ? { respectGitignore: options.respectGitignore }
        : {}),
    })
    for (const file of found) {
      if (seen.has(file)) continue
      seen.add(file)
      images.push({ abs: file, root, url: false })
    }
  }

  return images.sort((a, b) => a.abs.localeCompare(b.abs))
}

async function fetchImage(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch(
    (error: unknown) => {
      const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } }).cause
      const reason =
        cause?.code ??
        cause?.errors?.[0]?.code ??
        (error instanceof Error ? error.message : String(error))
      throw new Error(`download failed: ${reason}`)
    },
  )
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error('download is larger than 100 MB')
  return bytes
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function pick(computed: ComputedHashes, key: string, types: HashType[]): HashEntry {
  const entry: HashEntry = { file: key, width: computed.width, height: computed.height }
  for (const type of types) {
    const value = computed[type]
    if (value !== undefined) entry[type] = value
  }
  return entry
}

function validate(options: ImageHashRunOptions, perFile: boolean): void {
  if (options.out !== undefined && perFile) {
    throw new ImageHashUsageError('--out cannot be combined with --per-file or --out-dir')
  }
  if (options.check) {
    if (options.out === undefined && !perFile) {
      throw new ImageHashUsageError(
        '--check needs the output to compare against: pass -o, --per-file or --out-dir',
      )
    }
    if (options.dryRun) throw new ImageHashUsageError('--check cannot be combined with --dry-run')
    if (options.update) throw new ImageHashUsageError('--check cannot be combined with --update')
  }
  if (options.update && (options.out === undefined || perFile)) {
    throw new ImageHashUsageError('--update merges into the single file given with -o')
  }
  if (options.prune && !options.update) {
    throw new ImageHashUsageError('--prune only makes sense together with --update')
  }
}

export async function runImageHash(options: ImageHashRunOptions): Promise<ImageHashReport> {
  const format = options.format ?? 'json'
  const exportName = validateExportName(options.exportName ?? DEFAULT_EXPORT_NAME)
  const perFile = Boolean(options.perFile) || options.outDir !== undefined
  const dryRun = Boolean(options.dryRun)
  const check = Boolean(options.check)
  validate(options, perFile)

  const suffix = validateSuffix(options.suffix, options.types, format)
  const outExtension = normalizeOutExtension(options.outExtension, format)
  const size = options.size ?? DEFAULT_SAMPLE_SIZE
  const components = options.components ?? DEFAULT_BLURHASH_COMPONENTS
  const budget = options.budget ?? DEFAULT_HAZEHASH_BUDGET
  const params = `${size}|${componentsLabel(components)}|${budget}`
  const keyBase = resolve(options.cwd, options.keyBase ?? '.')
  const keyPrefix = options.keyPrefix ?? ''
  const keyOf = (source: SourceImage): string =>
    source.url ? source.abs : `${keyPrefix}${toPosix(relative(keyBase, source.abs))}`

  const errors: ImageHashError[] = []
  const images = collectImages(options, errors)

  const cachePath = options.cache !== undefined ? resolve(options.cwd, options.cache) : null
  const cache = cachePath ? loadCache(cachePath) : emptyCache()
  const newRecords: Record<string, CacheRecord> = {}

  let sharpPromise: Promise<SharpFactory> | null = null
  const loadConfiguredSharp = async (): Promise<SharpFactory> => {
    const loaded =
      options.sharp ??
      (await loadSharp({ assumeYes: options.assumeYes ?? false, cwd: options.cwd }))
    loaded.cache?.(false)
    return loaded
  }
  const getSharp = (): Promise<SharpFactory> => {
    if (!sharpPromise) sharpPromise = loadConfiguredSharp()
    return sharpPromise
  }

  const computeOptions = {
    types: options.types,
    size,
    components,
    budget,
    ...(options.maxPixels !== undefined ? { maxPixels: options.maxPixels } : {}),
  }

  let done = 0
  let cached = 0
  const total = images.length
  const entries: HashEntry[] = []
  const sources = new Map<string, SourceImage>()

  const results = await mapWithConcurrency(images, options.concurrency ?? 4, async (image) => {
    const key = keyOf(image)
    const display = image.url ? image.abs : toPosix(relative(options.cwd, image.abs))
    try {
      let computed: ComputedHashes
      if (image.url) {
        const bytes = await fetchImage(image.abs)
        computed = await computeHashes(await getSharp(), bytes, computeOptions)
      } else {
        const stat = statSync(image.abs)
        const sig = `${stat.mtimeMs}:${stat.size}`
        const cacheKey = toPosix(relative(options.cwd, image.abs))
        const previous = cache.files[cacheKey]
        const hit = cachePath ? cacheHit(previous, sig, params, options.types) : null
        if (hit) {
          computed = hit
          cached++
        } else {
          computed = await computeHashes(await getSharp(), image.abs, computeOptions)
          const base =
            previous && previous.sig === sig && previous.params === params ? previous : {}
          newRecords[cacheKey] = { ...base, ...computed, sig, params }
        }
      }
      return { image, entry: pick(computed, key, options.types) }
    } catch (error) {
      return { image, error: { file: display, message: friendlyMessage(error, options.maxPixels) } }
    } finally {
      done++
      options.onProgress?.({ done, total, cached })
    }
  })

  for (const result of results) {
    if ('entry' in result) {
      entries.push(result.entry)
      sources.set(result.entry.file, result.image)
    } else {
      errors.push(result.error)
    }
  }
  entries.sort((a, b) => a.file.localeCompare(b.file))

  const outputs: PlannedOutput[] = []
  let stdout: string | null = null
  let pruned = 0

  if (perFile) {
    const claimed = new Set<string>()
    const outDirAbs = options.outDir !== undefined ? resolve(options.cwd, options.outDir) : null
    for (const entry of entries) {
      const source = sources.get(entry.file) as SourceImage
      if (source.url && outDirAbs === null) {
        errors.push({
          file: entry.file,
          message: 'a URL input needs --out-dir for its output file',
        })
        continue
      }
      const targetDir = source.url
        ? (outDirAbs as string)
        : outDirAbs !== null
          ? join(outDirAbs, relative(source.root, dirname(source.abs)))
          : dirname(source.abs)
      const imageName = source.url ? urlBaseName(source.abs) : source.abs
      for (const unit of formatPerFile(entry, options.types, format)) {
        const target = join(targetDir, outputFileName(imageName, suffix, unit.token, outExtension))
        if (claimed.has(target)) {
          errors.push({ file: entry.file, message: `output ${target} is already taken` })
          continue
        }
        claimed.add(target)
        outputs.push({ path: target, content: unit.content })
      }
    }
  } else {
    let outputEntries = entries
    if (options.update) {
      const target = resolve(options.cwd, options.out as string)
      const existing = existsSync(target)
        ? parseAggregate(readFileSync(target, 'utf8'), format)
        : []
      const merged = new Map<string, HashEntry>(existing.map((entry) => [entry.file, entry]))
      const freshKeys = new Set(entries.map((entry) => entry.file))
      for (const entry of entries) merged.set(entry.file, { ...merged.get(entry.file), ...entry })
      if (options.prune) {
        for (const key of [...merged.keys()]) {
          if (freshKeys.has(key) || isUrl(key)) continue
          const local = key.startsWith(keyPrefix) ? key.slice(keyPrefix.length) : key
          if (!existsSync(resolve(keyBase, local))) {
            merged.delete(key)
            pruned++
          }
        }
      }
      outputEntries = [...merged.values()].sort((a, b) => a.file.localeCompare(b.file))
    }
    const outputTypes = options.update
      ? orderTypes([
          ...options.types,
          ...outputEntries.flatMap((entry) =>
            ALL_TYPES.filter((type) => entry[type] !== undefined),
          ),
        ])
      : options.types
    const content = formatAggregate(outputEntries, outputTypes, format, exportName)
    if (options.out !== undefined) {
      outputs.push({ path: resolve(options.cwd, options.out), content })
    } else if (!dryRun && !check) {
      stdout = content
    }
  }

  const written: string[] = []
  const outdated: OutdatedOutput[] = []
  for (const output of outputs) {
    const display = toPosix(relative(options.cwd, output.path))
    if (check) {
      if (!existsSync(output.path)) {
        outdated.push({ file: display, reason: 'missing' })
      } else if (
        normalizeNewlines(readFileSync(output.path, 'utf8')) !== normalizeNewlines(output.content)
      ) {
        outdated.push({ file: display, reason: 'changed' })
      }
      continue
    }
    if (!dryRun) writeText(output.path, output.content)
    written.push(display)
  }

  if (cachePath && !dryRun && !check && Object.keys(newRecords).length > 0) {
    saveCache(cachePath, { version: 1, files: { ...cache.files, ...newRecords } })
  }

  return {
    filesScanned: images.length,
    entries,
    written,
    errors,
    stdout,
    dryRun,
    check,
    checked: check ? outputs.length : 0,
    outdated,
    cached,
    pruned,
    exitCode: errors.length > 0 || outdated.length > 0 ? 1 : 0,
  }
}
