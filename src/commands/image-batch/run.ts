import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { createStyle } from '../../format/style.js'
import { formatBytes } from '../../format/bytes.js'
import type { VibesOptions } from '../../format/vibes.js'
import {
  defaultTerminal,
  isInteractive,
  multiSelect,
  promptChoice,
  type SelectItem,
  type TerminalIO,
} from '../../utils/tty.js'
import type { HashType } from '../image-hash/core.js'
import { computeHashes, friendlyMessage, type ComputedHashes } from '../image-hash/hash.js'
import { loadSharp, type SharpFactory } from '../image-hash/sharp-loader.js'
import {
  backupDirFor,
  backupPathFor,
  copyIntoBackup,
  DEFAULT_BACKUP_DIR,
  newJournal,
  saveJournal,
  type Journal,
} from './backup.js'
import {
  cacheKeyFor,
  defaultCachePath,
  emptyBatchCache,
  loadBatchCache,
  saveBatchCache,
} from './cache.js'
import {
  normalizeFormat,
  unsupportedFormats,
  type CodecMap,
  type OutputFormatName,
  type QualityInput,
} from './codecs.js'
import {
  emptyConfig,
  type BatchConfig,
  type PlaceholderSettings,
  type RecipeLayer,
} from './config.js'
import { ImageBatchAbortError, ImageBatchUsageError } from './errors.js'
import { parseSize, type Fit } from './geometry.js'
import { BATCH_IMAGE_EXTENSIONS, collectInputs, type InputFile } from './inputs.js'
import {
  createOverwriteResolver,
  type ConflictInfo,
  type ConflictPrompt,
  type OverwriteMode,
} from './overwrite.js'
import {
  describeCollisions,
  isSource,
  planJobs,
  readSource,
  validateReplacePlan,
  type PlanResult,
  type Placement,
  type PlannedJob,
  type SharpFn,
  type SourceFailure,
  type SourceInfo,
} from './plan.js'
import { renderJob, writeAtomic } from './process.js'
import type { SharpenLayer } from './sharpen.js'
import { attachSharpenPresets } from './sharpen-presets.js'
import { parseTemplate } from './template.js'

export interface BatchOverrides {
  size?: string
  widths?: number[]
  heights?: number[]
  formats?: string[]
  quality?: QualityInput
  codecs?: CodecMap
  fit?: Fit
  name?: string
  flatten?: boolean | string
  longEdge?: number[]
  shortEdge?: number[]
  megapixels?: number[]
  percent?: number[]
  matchOrientation?: boolean
  noResize?: boolean
  maxBytes?: number
  sharpen?: SharpenLayer
}

export interface BatchProgress {
  done: number
  total: number
}

export interface ReplaceSummary {
  count: number
  bytes: number
  backupDir: string | null
}

export interface ImageBatchOptions {
  paths: string[]
  cwd: string
  out?: string
  beside?: boolean
  replace?: boolean
  backup?: string | false
  onlyIfSmaller?: boolean
  config?: BatchConfig
  configLabel?: string
  overrides?: BatchOverrides
  recursive?: boolean
  extensions?: string[]
  ignoreGlobs?: string[]
  respectGitignore?: boolean
  include?: string[]
  exclude?: string[]
  flat?: boolean
  list?: boolean
  select?: boolean
  overwrite?: OverwriteMode
  force?: boolean
  placeholders?: PlaceholderSettings
  emit?: string
  keyPrefix?: string
  cache?: string | false
  cacheBase?: string
  globalDir?: string
  concurrency?: number
  maxPixels?: number
  dryRun?: boolean
  assumeYes?: boolean
  sharp?: SharpFn
  io?: TerminalIO
  interactive?: boolean
  prompt?: ConflictPrompt
  confirm?: (summary: ReplaceSummary) => Promise<boolean>
  now?: Date
  style?: VibesOptions
  onProgress?: (progress: BatchProgress) => void
}

export type JobStatus =
  | 'written'
  | 'up-to-date'
  | 'skipped'
  | 'conflict'
  | 'would-write'
  | 'would-overwrite'
  | 'replaced'
  | 'kept'
  | 'already-processed'
  | 'would-replace'
  | 'would-keep'
  | 'error'

export interface BatchJobResult {
  source: string
  sourceAbs: string
  output: string
  outputAbs: string
  recipe: string
  format: OutputFormatName
  width: number
  height: number
  status: JobStatus
  bytes?: number
  before?: number
  message?: string
}

export interface BatchSourceSummary {
  file: string
  width: number
  height: number
  format: string
  bytes: number
}

export interface ImageBatchReport {
  placement: Placement
  out: string
  backupDir?: string
  backupEnabled: boolean
  configLabel?: string
  dryRun: boolean
  listOnly: boolean
  sources: BatchSourceSummary[]
  failures: { file: string; message: string }[]
  unmatched: string[]
  derived: string[]
  vectors: string[]
  results: BatchJobResult[]
  counts: Record<JobStatus, number>
  deduped: number
  bytesIn: number
  bytesOut: number
  emitPath?: string
  aborted: boolean
  cancelled: boolean
  nothingSelected: boolean
  exitCode: number
}

const DEFAULT_CONCURRENCY = 4
const JOURNAL_FLUSH_EVERY = 25

function emptyCounts(): Record<JobStatus, number> {
  return {
    written: 0,
    'up-to-date': 0,
    skipped: 0,
    conflict: 0,
    'would-write': 0,
    'would-overwrite': 0,
    replaced: 0,
    kept: 0,
    'already-processed': 0,
    'would-replace': 0,
    'would-keep': 0,
    error: 0,
  }
}

function overrideLayer(overrides: BatchOverrides | undefined): RecipeLayer[] {
  if (!overrides) return []
  const layer: RecipeLayer = {}
  if (overrides.size) layer.size = parseSize(overrides.size, 'size')
  if (overrides.widths) layer.widths = overrides.widths
  if (overrides.heights) layer.heights = overrides.heights
  if (overrides.longEdge) layer.longEdge = overrides.longEdge
  if (overrides.shortEdge) layer.shortEdge = overrides.shortEdge
  if (overrides.megapixels) layer.megapixels = overrides.megapixels
  if (overrides.percent) layer.percent = overrides.percent
  if (overrides.matchOrientation) layer.matchOrientation = true
  if (overrides.noResize) layer.noResize = true
  if (overrides.maxBytes !== undefined) layer.maxBytes = overrides.maxBytes
  if (overrides.sharpen) layer.sharpen = overrides.sharpen
  if (overrides.formats) {
    layer.formats = overrides.formats.map((format) => normalizeFormat(format, '--formats'))
  }
  if (overrides.quality !== undefined) layer.quality = overrides.quality
  if (overrides.codecs) layer.codecs = overrides.codecs
  if (overrides.fit) layer.fit = overrides.fit
  if (overrides.name) {
    layer.template = { text: overrides.name, tokens: parseTemplate(overrides.name, '--name') }
  }
  if (overrides.flatten !== undefined && overrides.flatten !== false) {
    layer.flatten = overrides.flatten
  }
  return Object.keys(layer).length > 0 ? [layer] : []
}

async function pool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index] as T)
    }
  })
  await Promise.all(runners)
}

function summarize(source: SourceInfo): BatchSourceSummary {
  return {
    file: source.file.rel,
    width: source.width,
    height: source.height,
    format: source.format,
    bytes: source.bytes,
  }
}

const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex')

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function defaultPrompt(io: TerminalIO, style: VibesOptions): ConflictPrompt {
  const s = createStyle(style)
  return async (info: ConflictInfo) => {
    const why =
      info.reason === 'changed'
        ? 'was made by an earlier run, but the source or the settings changed'
        : 'already exists and was not made by this command'
    const answer = await promptChoice(
      io,
      `${s.warn('Output exists:')} ${s.path(info.outRel)} ${s.muted(`(${formatBytes(info.existingBytes)}, ${why})`)}`,
      [
        { key: 'y', label: 'overwrite this' },
        { key: 'a', label: 'overwrite this and all next' },
        { key: 's', label: 'skip this' },
        { key: 'n', label: 'skip all next' },
        { key: 'q', label: 'quit' },
      ],
      s,
      's',
    )
    return { y: 'yes', a: 'all', s: 'skip', n: 'none', q: 'quit' }[answer] as
      'yes' | 'all' | 'skip' | 'none' | 'quit'
  }
}

function defaultConfirm(io: TerminalIO, style: VibesOptions) {
  const s = createStyle(style)
  return async (summary: ReplaceSummary): Promise<boolean> => {
    const where = summary.backupDir
      ? `The originals are copied to ${s.path(summary.backupDir)} first.`
      : s.problem('There is NO backup (--no-backup): the originals are overwritten for good.')
    const answer = await promptChoice(
      io,
      `${s.warn('Replace')} ${s.value(`${summary.count} image${summary.count === 1 ? '' : 's'}`)} ${s.muted(`(${formatBytes(summary.bytes)})`)} ${s.warn('in place?')}\n  ${where}`,
      [
        { key: 'y', label: 'replace' },
        { key: 'n', label: 'cancel' },
      ],
      s,
      'n',
    )
    return answer === 'y'
  }
}

function placementOf(options: ImageBatchOptions): Placement {
  const chosen = [options.out !== undefined, options.beside, options.replace].filter(Boolean).length
  if (chosen > 1) {
    throw new ImageBatchUsageError(
      'pick one place for the results: --out <dir>, --beside (next to each source) or --replace (over the sources)',
    )
  }
  if (options.replace) return 'replace'
  if (options.beside) return 'beside'
  return 'out'
}

export async function runImageBatch(options: ImageBatchOptions): Promise<ImageBatchReport> {
  const cwd = resolve(options.cwd)
  const io = options.io ?? defaultTerminal()
  const interactive = options.interactive ?? isInteractive(io)
  const style = options.style ?? {}
  const config = attachSharpenPresets(options.config ?? emptyConfig(), {
    cwd,
    ...(options.globalDir !== undefined ? { globalDir: options.globalDir } : {}),
    extra: [options.overrides?.sharpen],
  })
  const now = options.now ?? new Date()
  const placement = placementOf(options)

  if (placement === 'out' && options.out === undefined && !options.list) {
    throw new ImageBatchUsageError(
      'image-batch needs a place for the results: --out <dir>, --beside (next to each source) or --replace (over the sources)',
    )
  }
  if (placement !== 'out' && options.flat) {
    throw new ImageBatchUsageError(
      '--flat only makes sense with --out: with --beside and --replace every result stays in its own folder',
    )
  }
  if (placement === 'replace' && options.overrides?.name !== undefined) {
    throw new ImageBatchUsageError(
      '--name has no effect with --replace: the result takes the name of the file it replaces',
    )
  }
  if (
    placement !== 'replace' &&
    (options.backup !== undefined || options.onlyIfSmaller === false)
  ) {
    throw new ImageBatchUsageError(
      '--backup, --no-backup and --no-only-if-smaller belong to --replace',
    )
  }
  const outDir = resolve(cwd, options.out ?? '.')
  const onlyIfSmaller = options.onlyIfSmaller ?? true

  const report: ImageBatchReport = {
    placement,
    out: placement === 'out' ? outDir : '',
    backupEnabled: placement === 'replace' && options.backup !== false,
    dryRun: Boolean(options.dryRun),
    listOnly: Boolean(options.list),
    sources: [],
    failures: [],
    unmatched: [],
    derived: [],
    vectors: [],
    results: [],
    counts: emptyCounts(),
    deduped: 0,
    bytesIn: 0,
    bytesOut: 0,
    aborted: false,
    cancelled: false,
    nothingSelected: false,
    exitCode: 0,
  }
  if (options.configLabel !== undefined) report.configLabel = options.configLabel

  if (options.placeholders && options.placeholders.types.length > 0 && !options.emit) {
    throw new ImageBatchUsageError(
      'placeholder hashes are written into the --emit file — pass --emit <file> as well',
    )
  }
  const placeholders = options.emit ? (options.placeholders ?? config.placeholders) : undefined

  const backupBase = resolve(
    cwd,
    typeof options.backup === 'string' ? options.backup : DEFAULT_BACKUP_DIR,
  )
  const cachePath =
    options.cache === false
      ? null
      : (options.cache ??
        defaultCachePath(
          cacheKeyFor(
            placement,
            outDir,
            (options.paths.length > 0 ? options.paths : ['.']).map((path) => resolve(cwd, path)),
          ),
          options.cacheBase,
        ))
  const cache = cachePath ? loadBatchCache(cachePath) : emptyBatchCache()
  let cacheDirty = false

  let files: InputFile[] = collectInputs({
    paths: options.paths,
    cwd,
    extensions: options.extensions ?? BATCH_IMAGE_EXTENSIONS,
    ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    ignoreGlobs: [...(options.ignoreGlobs ?? []), `${DEFAULT_BACKUP_DIR}/`],
    ...(options.respectGitignore !== undefined
      ? { respectGitignore: options.respectGitignore }
      : {}),
    ...(options.include ? { include: options.include } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(placement === 'out' && options.out !== undefined ? { outDir } : {}),
  })
  files = files.filter((file) => !isInside(backupBase, file.abs))
  if (placement === 'beside') {
    const known = files.filter((file) => cache.outputs[file.abs] !== undefined)
    report.derived.push(...known.map((file) => file.rel))
    files = files.filter((file) => cache.outputs[file.abs] === undefined)
  }
  if (files.length === 0) return report

  const sharp: SharpFn =
    options.sharp ??
    ((await loadSharp({
      cwd,
      command: 'image-batch',
      createError: (message) => new ImageBatchUsageError(message),
      ...(options.assumeYes !== undefined ? { assumeYes: options.assumeYes } : {}),
    })) as unknown as SharpFn)

  const loaded: (SourceInfo | SourceFailure)[] = new Array(files.length)
  await pool(
    files.map((file, index) => ({ file, index })),
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async ({ file, index }) => {
      loaded[index] = await readSource(sharp, file, index + 1, options.maxPixels)
    },
  )
  let sources: SourceInfo[] = []
  for (const item of loaded) {
    if (!isSource(item)) {
      report.failures.push({ file: item.file.rel, message: item.message })
    } else if (placement === 'replace' && item.format === 'svg') {
      report.vectors.push(item.file.rel)
    } else {
      sources.push(item)
    }
  }

  if (options.select) {
    if (!interactive) {
      throw new ImageBatchUsageError(
        '--select needs an interactive terminal — use --list to print the files instead',
      )
    }
    const s = createStyle(style)
    const items: SelectItem<SourceInfo>[] = sources.map((source) => ({
      label: source.file.rel,
      hint: `${source.width}×${source.height} · ${source.format} · ${formatBytes(source.bytes)}`,
      value: source,
      selected: true,
    }))
    const picked = await multiSelect(
      io,
      items,
      {
        title: `Pick the images to process (${items.length} found)`,
        help: 'space toggle · a all · n none · i invert · / filter · enter confirm · q cancel',
        filterable: true,
      },
      s,
    )
    if (picked === null || picked.length === 0) {
      report.nothingSelected = true
      report.sources = []
      return report
    }
    sources = picked
  }

  report.sources = sources.map(summarize)
  if (options.list) return report

  const hashes = new Map<string, ComputedHashes>()
  if (placeholders && placeholders.types.length > 0) {
    await pool(sources, options.concurrency ?? DEFAULT_CONCURRENCY, async (source) => {
      try {
        const computed = await computeHashes(
          sharp as unknown as SharpFactory,
          readFileSync(source.file.abs),
          {
            types: placeholders.types as HashType[],
            size: 100,
            components:
              placeholders.components && placeholders.components !== 'auto'
                ? {
                    x: Number(placeholders.components[0]),
                    y: Number(placeholders.components[2]),
                  }
                : placeholders.components === 'auto'
                  ? 'auto'
                  : { x: 4, y: 3 },
            ...(placeholders.budget !== undefined ? { budget: placeholders.budget } : {}),
            ...(options.maxPixels !== undefined ? { maxPixels: options.maxPixels } : {}),
          },
        )
        hashes.set(source.file.abs, computed)
      } catch (error) {
        report.failures.push({
          file: source.file.rel,
          message: `placeholders: ${friendlyMessage(error, options.maxPixels)}`,
        })
      }
    })
  }

  const planOptions = (list: SourceInfo[]) => ({
    sources: list,
    config,
    overrides: overrideLayer(options.overrides),
    placement,
    outDir,
    ...(options.flat ? { flat: true } : {}),
    now,
  })
  let plan: PlanResult = planJobs(planOptions(sources))
  if (placement === 'beside') {
    for (let round = 0; round < 4; round++) {
      const produced = new Map<string, PlannedJob>()
      for (const job of plan.jobs) produced.set(job.outAbs.toLowerCase(), job)
      const derived = sources.filter((source) => {
        const job = produced.get(source.file.abs.toLowerCase())
        return job !== undefined && job.source !== source
      })
      if (derived.length === 0) break
      report.derived.push(...derived.map((source) => source.file.rel))
      sources = sources.filter((source) => !derived.includes(source))
      report.sources = sources.map(summarize)
      plan = planJobs(planOptions(sources))
    }
  }
  if (plan.collisions.length > 0) {
    throw new ImageBatchUsageError(describeCollisions(plan.collisions))
  }
  if (placement === 'replace') validateReplacePlan(plan.jobs)
  const missingFormats = unsupportedFormats(
    sharp,
    plan.jobs.map((job) => job.format),
  )
  if (missingFormats.length > 0) {
    throw new ImageBatchUsageError(
      `this sharp build cannot write ${missingFormats.join(', ')} (libvips was built without the encoder) — pick other formats`,
    )
  }
  report.deduped = plan.deduped
  report.unmatched = plan.unmatched.map((source) => source.file.rel)

  let backupDir: string | null = null
  let journal: Journal | null = null
  const wantsBackup = placement === 'replace' && options.backup !== false && !options.dryRun
  const ensureBackup = (): string | null => {
    if (!wantsBackup) return null
    if (backupDir === null) {
      backupDir = backupDirFor(
        cwd,
        typeof options.backup === 'string' ? options.backup : undefined,
        now,
      )
      journal = newJournal(cwd, now)
      report.backupDir = backupDir
    }
    return backupDir
  }

  if (placement === 'replace' && !options.dryRun && plan.jobs.length > 0) {
    const summary: ReplaceSummary = {
      count: plan.jobs.length,
      bytes: plan.jobs.reduce((sum, job) => sum + job.source.bytes, 0),
      backupDir: wantsBackup ? resolve(backupBase, '<date>') : null,
    }
    if (!options.assumeYes) {
      if (!interactive) {
        throw new ImageBatchUsageError(
          '--replace changes the original files — pass --yes to confirm (or --dry-run to preview what would change)',
        )
      }
      const confirmed = await (options.confirm ?? defaultConfirm(io, style))(summary)
      if (!confirmed) {
        report.cancelled = true
        report.exitCode = 1
        return report
      }
    }
  }

  const explicitMode = options.overwrite
  const mode: OverwriteMode = explicitMode ?? (interactive ? 'ask' : 'skip')
  const implicitSkip = explicitMode === undefined && !interactive
  const resolver = createOverwriteResolver(
    mode,
    mode === 'ask' ? (options.prompt ?? defaultPrompt(io, style)) : undefined,
  )
  let chain: Promise<unknown> = Promise.resolve()
  const decide = (info: ConflictInfo) => {
    const next = chain.then(() => resolver.decide(info))
    chain = next.catch(() => undefined)
    return next
  }

  const groups = new Map<SourceInfo, PlannedJob[]>()
  for (const job of plan.jobs) {
    const list = groups.get(job.source)
    if (list) list.push(job)
    else groups.set(job.source, [job])
  }

  const total = plan.jobs.length
  let done = 0
  const results = new Map<PlannedJob, BatchJobResult>()
  const renderOptions = options.maxPixels !== undefined ? { maxPixels: options.maxPixels } : {}

  const baseResult = (job: PlannedJob): BatchJobResult => ({
    source: job.source.file.rel,
    sourceAbs: job.source.file.abs,
    output: job.outRel,
    outputAbs: job.outAbs,
    recipe: job.recipeLabel,
    format: job.format,
    width: job.width,
    height: job.height,
    status: 'written',
  })

  const replaceJob = async (job: PlannedJob, result: BatchJobResult): Promise<void> => {
    const source = job.source
    const entry = cache.outputs[job.outAbs]
    result.before = source.bytes
    if (
      !options.force &&
      entry !== undefined &&
      entry.hash === source.hash &&
      entry.settingsKey === job.settingsKey
    ) {
      result.status = 'already-processed'
      result.bytes = source.bytes
      return
    }
    const buffer = readFileSync(source.file.abs)
    const data = await renderJob(sharp, job, buffer, renderOptions)
    if (onlyIfSmaller && data.length >= source.bytes) {
      result.status = options.dryRun ? 'would-keep' : 'kept'
      result.bytes = source.bytes
      if (!options.dryRun) {
        cache.outputs[job.outAbs] = {
          fingerprint: job.fingerprint,
          settingsKey: job.settingsKey,
          hash: source.hash,
          bytes: source.bytes,
        }
        cacheDirty = true
      }
      return
    }
    if (options.dryRun) {
      result.status = 'would-replace'
      result.bytes = data.length
      return
    }
    const dir = ensureBackup()
    let saved: string | null = null
    if (dir !== null) {
      saved = backupPathFor(dir, cwd, source.file.abs)
      copyIntoBackup(source.file.abs, saved)
    }
    try {
      writeAtomic(job.outAbs, data)
    } catch (error) {
      if (saved !== null) rmSync(saved, { force: true })
      throw error
    }
    const hashAfter = sha1(data)
    if (journal !== null && saved !== null && dir !== null) {
      journal.entries.push({
        path: job.outAbs,
        backup: saved,
        bytesBefore: source.bytes,
        bytesAfter: data.length,
        hashBefore: source.hash,
        hashAfter,
      })
      if (journal.entries.length % JOURNAL_FLUSH_EVERY === 0) saveJournal(dir, journal)
    }
    cache.outputs[job.outAbs] = {
      fingerprint: job.fingerprint,
      settingsKey: job.settingsKey,
      hash: hashAfter,
      bytes: data.length,
    }
    cacheDirty = true
    result.status = 'replaced'
    result.bytes = data.length
  }

  const processGroup = async (jobs: PlannedJob[]): Promise<void> => {
    let buffer: Buffer | null = null
    for (const job of jobs) {
      if (report.aborted) return
      const result = baseResult(job)
      try {
        if (placement === 'replace') {
          await replaceJob(job, result)
        } else {
          const exists = existsSync(job.outAbs)
          const existingBytes = exists ? statSync(job.outAbs).size : 0
          const known = cache.outputs[job.outAbs]
          const upToDate =
            exists &&
            !options.force &&
            known !== undefined &&
            known.fingerprint === job.fingerprint &&
            known.bytes === existingBytes
          if (upToDate) {
            result.status = 'up-to-date'
            result.bytes = existingBytes
          } else {
            let action: 'write' | 'skip' | 'fail' = 'write'
            if (exists && !options.force) {
              if (options.dryRun) {
                result.status = 'would-overwrite'
                result.bytes = existingBytes
                results.set(job, result)
                done += 1
                options.onProgress?.({ done, total })
                continue
              }
              action = await decide({
                outRel: job.outRel,
                sourceRel: job.source.file.rel,
                existingBytes,
                reason: known ? 'changed' : 'unknown',
              })
            }
            if (action === 'skip') {
              result.status = 'skipped'
              result.bytes = existingBytes
            } else if (action === 'fail') {
              result.status = 'conflict'
              result.bytes = existingBytes
            } else if (options.dryRun) {
              result.status = 'would-write'
            } else {
              buffer ??= readFileSync(job.source.file.abs)
              const data = await renderJob(sharp, job, buffer, renderOptions)
              writeAtomic(job.outAbs, data)
              cache.outputs[job.outAbs] = { fingerprint: job.fingerprint, bytes: data.length }
              cacheDirty = true
              result.status = 'written'
              result.bytes = data.length
            }
          }
        }
      } catch (error) {
        if (error instanceof ImageBatchAbortError) {
          report.aborted = true
          return
        }
        result.status = 'error'
        result.message = friendlyMessage(error, options.maxPixels)
      }
      results.set(job, result)
      done += 1
      options.onProgress?.({ done, total })
    }
  }

  try {
    await pool([...groups.values()], options.concurrency ?? DEFAULT_CONCURRENCY, processGroup)
  } finally {
    const finalJournal = journal as Journal | null
    const finalDir = backupDir as string | null
    if (finalJournal !== null && finalDir !== null && finalJournal.entries.length > 0) {
      saveJournal(finalDir, finalJournal)
    }
  }

  for (const job of plan.jobs) {
    const result = results.get(job)
    if (result) report.results.push(result)
  }
  for (const result of report.results) report.counts[result.status] += 1
  for (const result of report.results) {
    if (result.status === 'written') {
      report.bytesOut += result.bytes ?? 0
    } else if (result.status === 'replaced') {
      report.bytesIn += result.before ?? 0
      report.bytesOut += result.bytes ?? 0
    }
  }
  if (placement !== 'replace') {
    const processed = new Set<SourceInfo>()
    for (const job of plan.jobs) {
      if (results.get(job)?.status === 'written') processed.add(job.source)
    }
    report.bytesIn = [...processed].reduce((sum, source) => sum + source.bytes, 0)
  }

  if (!options.dryRun && cachePath && cacheDirty) saveBatchCache(cachePath, cache)

  if (options.emit && !options.dryRun && !report.aborted) {
    writeEmit(resolve(cwd, options.emit), report, sources, hashes, options.keyPrefix ?? '')
    report.emitPath = resolve(cwd, options.emit)
  }

  const failed =
    report.counts.error > 0 ||
    report.counts.conflict > 0 ||
    report.failures.length > 0 ||
    report.aborted ||
    (implicitSkip && report.counts.skipped > 0)
  report.exitCode = failed ? 1 : 0
  return report
}

function writeEmit(
  path: string,
  report: ImageBatchReport,
  sources: SourceInfo[],
  hashes: Map<string, ComputedHashes>,
  keyPrefix: string,
): void {
  const skippedStatuses = new Set<string>(['error', 'conflict'])
  const bySource = new Map<string, BatchJobResult[]>()
  for (const result of report.results) {
    if (skippedStatuses.has(result.status)) continue
    const list = bySource.get(result.source)
    if (list) list.push(result)
    else bySource.set(result.source, [result])
  }
  const sourcesOut: Record<string, unknown> = {}
  const placeholders: Record<string, unknown> = {}
  for (const source of sources) {
    const outputs = bySource.get(source.file.rel) ?? []
    const computed = hashes.get(source.file.abs)
    const hashFields: Record<string, string> = {}
    if (computed) {
      for (const key of ['hazehash', 'blurhash', 'thumbhash', 'color', 'preview'] as const) {
        const value = computed[key]
        if (value !== undefined) hashFields[key] = value
      }
    }
    sourcesOut[source.file.rel] = {
      width: source.width,
      height: source.height,
      format: source.format,
      bytes: source.bytes,
      ...hashFields,
      outputs: outputs.map((output) => ({
        path: output.output,
        width: output.width,
        height: output.height,
        format: output.format,
        ...(output.bytes !== undefined ? { bytes: output.bytes } : {}),
      })),
    }
    if (Object.keys(hashFields).length > 0) {
      for (const output of outputs) {
        placeholders[`${keyPrefix}${output.output}`] = {
          ...hashFields,
          width: output.width,
          height: output.height,
        }
      }
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, sources: sourcesOut, placeholders }, null, 2)}\n`,
  )
}
