import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Sharp, SharpOptions } from 'sharp'
import { matchGlob } from '../../utils/glob.js'
import { friendlyMessage } from '../image-hash/hash.js'
import {
  FORMAT_EXTENSIONS,
  describeOptions,
  resolveCodecOptions,
  supportsQualityLimit,
  type CodecOptions,
  type OutputFormatName,
} from './codecs.js'
import { resolveRecipe, type BatchConfig, type RecipeLayer, type ResolvedRecipe } from './config.js'
import { ImageBatchUsageError } from './errors.js'
import {
  boxForLongEdge,
  boxForMegapixels,
  boxForPercent,
  boxForShortEdge,
  computeGeometry,
  matchBoxOrientation,
  orientedSize,
  sizeLabel,
  type Box,
  type Geometry,
} from './geometry.js'
import type { InputFile } from './inputs.js'
import type { SharpenSpec } from './sharpen.js'
import {
  defaultTemplate,
  expandTemplate,
  formatDate,
  parseTemplate,
  type TemplateToken,
  type TemplateValues,
} from './template.js'

export type SharpFn = (input?: Buffer | string, options?: SharpOptions) => Sharp

export const FINGERPRINT_VERSION = 1

export type Placement = 'out' | 'beside' | 'replace'

export interface SourceInfo {
  file: InputFile
  width: number
  height: number
  rawWidth: number
  rawHeight: number
  orientation: number | undefined
  format: string
  compression: string | undefined
  hasAlpha: boolean
  pages: number
  animated: boolean
  bytes: number
  mtimeMs: number
  hash: string
  index: number
}

export interface SourceFailure {
  file: InputFile
  message: string
}

export interface Operations {
  autoOrient: boolean
  rotate: number | undefined
  flip: boolean
  flop: boolean
  grayscale: boolean
  sharpen: SharpenSpec | undefined
  blur: number | undefined
  flatten: string | true | undefined
  metadata: string
  fit: string
  position: string | undefined
  background: string | undefined
}

export interface PlannedJob {
  source: SourceInfo
  recipeLabel: string
  outRel: string
  outAbs: string
  format: OutputFormatName
  codec: CodecOptions
  width: number
  height: number
  geometry: Geometry
  ops: Operations
  maxBytes: number | undefined
  fingerprint: string
  settingsKey: string
}

export interface Collision {
  path: string
  claims: string[]
  sources: string[]
  recipes: string[]
}

export interface PlanResult {
  jobs: PlannedJob[]
  collisions: Collision[]
  deduped: number
  unmatched: SourceInfo[]
}

export function mapSourceFormat(
  format: string | undefined,
  compression?: string,
): string | undefined {
  switch (format) {
    case 'jpeg':
      return 'jpg'
    case 'png':
    case 'webp':
    case 'avif':
    case 'gif':
    case 'tiff':
    case 'jp2':
      return format
    case 'heif':
      return compression === 'av1' ? 'avif' : 'heif'
    case 'svg':
      return 'svg'
    default:
      return undefined
  }
}

export async function readSource(
  sharp: SharpFn,
  file: InputFile,
  index: number,
  maxPixels: number | undefined,
): Promise<SourceInfo | SourceFailure> {
  try {
    const buffer = readFileSync(file.abs)
    const stat = statSync(file.abs)
    const options: SharpOptions = { failOn: 'truncated' }
    if (maxPixels !== undefined) options.limitInputPixels = maxPixels === 0 ? false : maxPixels
    const metadata = await sharp(buffer, options).metadata()
    if (!metadata.width || !metadata.height) {
      return { file, message: 'not a readable image — the file has no size information' }
    }
    const size = orientedSize(
      { width: metadata.width, height: metadata.height },
      metadata.orientation,
      true,
      undefined,
    )
    return {
      file,
      width: size.width,
      height: size.height,
      rawWidth: metadata.width,
      rawHeight: metadata.height,
      orientation: metadata.orientation,
      format: mapSourceFormat(metadata.format, metadata.compression) ?? String(metadata.format),
      compression: metadata.compression,
      hasAlpha: Boolean(metadata.hasAlpha),
      pages: metadata.pages ?? 1,
      animated: (metadata.pages ?? 1) > 1,
      bytes: buffer.length,
      mtimeMs: stat.mtimeMs,
      hash: createHash('sha1').update(buffer).digest('hex'),
      index,
    }
  } catch (error) {
    return { file, message: friendlyMessage(error, maxPixels) }
  }
}

export function isSource(value: SourceInfo | SourceFailure): value is SourceInfo {
  return 'hash' in value
}

function recipesFor(config: BatchConfig, source: SourceInfo): RecipeLayer[] | undefined {
  for (const rule of config.match) {
    if (matchGlob(rule.glob, source.file.rel)) return rule.outputs
  }
  if (config.outputs.length > 0) return config.outputs
  return config.match.length > 0 ? undefined : [{}]
}

function recipeLabel(layer: RecipeLayer, index: number): string {
  return layer.id ?? `#${index + 1}`
}

function outputFormats(recipe: ResolvedRecipe, source: SourceInfo): OutputFormatName[] {
  const formats = new Set<OutputFormatName>()
  for (const choice of recipe.formats) {
    if (choice !== 'original') {
      formats.add(choice)
      continue
    }
    const own = source.format
    if (own === 'svg') formats.add('png')
    else if ((Object.keys(FORMAT_EXTENSIONS) as string[]).includes(own)) {
      formats.add(own as OutputFormatName)
    } else {
      throw new ImageBatchUsageError(
        `${source.file.rel}: the source format "${own}" cannot be written back as "original" — pick a format explicitly`,
      )
    }
  }
  return [...formats]
}

type SpecKind = 'width' | 'height' | 'size' | 'long' | 'short' | 'mp' | 'percent' | 'original'

interface Spec {
  kind: SpecKind
  value: number | string
  box: Box
  scale: number
  requestedMp?: number
  requestedPercent?: number
}

function specsFor(recipe: ResolvedRecipe, dims: { width: number; height: number }): Spec[] {
  const specs: Spec[] = []
  const round = (n: number) => Math.max(1, Math.round(n))
  for (const scale of recipe.scales) {
    for (const width of recipe.widths) {
      specs.push({ kind: 'width', value: width, box: { width: round(width * scale) }, scale })
    }
    for (const height of recipe.heights) {
      specs.push({ kind: 'height', value: height, box: { height: round(height * scale) }, scale })
    }
    if (recipe.size) {
      let box = {
        width: round(recipe.size.width * scale),
        height: round(recipe.size.height * scale),
      }
      if (recipe.matchOrientation) box = matchBoxOrientation(box, dims)
      specs.push({ kind: 'size', value: `${recipe.size.width}x${recipe.size.height}`, box, scale })
    }
    for (const edge of recipe.longEdge) {
      specs.push({
        kind: 'long',
        value: edge,
        box: boxForLongEdge(dims, round(edge * scale)),
        scale,
      })
    }
    for (const edge of recipe.shortEdge) {
      specs.push({
        kind: 'short',
        value: edge,
        box: boxForShortEdge(dims, round(edge * scale)),
        scale,
      })
    }
    for (const megapixels of recipe.megapixels) {
      const requested = megapixels * scale * scale
      specs.push({
        kind: 'mp',
        value: megapixels,
        box: boxForMegapixels(dims, requested),
        scale,
        requestedMp: requested,
      })
    }
    for (const percent of recipe.percent) {
      const requested = percent * scale
      specs.push({
        kind: 'percent',
        value: percent,
        box: boxForPercent(dims, requested),
        scale,
        requestedPercent: requested,
      })
    }
    if (
      recipe.widths.length === 0 &&
      recipe.heights.length === 0 &&
      !recipe.size &&
      recipe.longEdge.length === 0 &&
      recipe.shortEdge.length === 0 &&
      recipe.megapixels.length === 0 &&
      recipe.percent.length === 0
    ) {
      specs.push({
        kind: 'original',
        value: 'original',
        box: { width: round(dims.width * scale), height: round(dims.height * scale) },
        scale,
      })
    }
  }
  return specs
}

const defaultTokensCache = new Map<string, TemplateToken[]>()

function defaultTokensFor(kind: SpecKind, scale: number): TemplateToken[] {
  const key = `${kind}:${scale !== 1}`
  const cached = defaultTokensCache.get(key)
  if (cached) return cached
  const text = defaultTemplate({
    widths: kind === 'width',
    heights: kind === 'height',
    size: kind === 'size',
    longEdge: kind === 'long',
    shortEdge: kind === 'short',
    megapixels: kind === 'mp',
    percent: kind === 'percent',
    scale: kind === 'original' && scale !== 1,
  })
  const tokens = parseTemplate(text, 'default name')
  defaultTokensCache.set(key, tokens)
  return tokens
}

function requestedNumber(value: number): string {
  return String(Number(value.toPrecision(3)))
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function fingerprintOf(
  source: SourceInfo,
  geometry: Geometry,
  format: OutputFormatName,
  codec: CodecOptions,
  ops: Operations,
  maxBytes: number | undefined,
): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        v: FINGERPRINT_VERSION,
        src: [source.bytes, source.hash],
        geometry,
        format,
        codec,
        ops,
        maxBytes,
      }),
    )
    .digest('hex')
}

function settingsKeyOf(
  spec: Spec,
  format: OutputFormatName,
  codec: CodecOptions,
  ops: Operations,
  withoutEnlargement: boolean,
  maxBytes: number | undefined,
): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        v: FINGERPRINT_VERSION,
        kind: spec.kind,
        value: spec.value,
        scale: spec.scale,
        format,
        codec,
        ops,
        withoutEnlargement,
        maxBytes,
        match: spec.kind === 'size' ? spec.box : undefined,
      }),
    )
    .digest('hex')
}

export interface PlanOptions {
  sources: SourceInfo[]
  config: BatchConfig
  overrides: RecipeLayer[]
  placement?: Placement
  outDir?: string
  flat?: boolean
  now?: Date
}

export function planJobs(options: PlanOptions): PlanResult {
  const date = formatDate(options.now ?? new Date())
  const placement: Placement = options.placement ?? 'out'
  const jobs: PlannedJob[] = []
  const unmatched: SourceInfo[] = []
  const claims = new Map<string, PlannedJob[]>()
  let deduped = 0

  for (const source of options.sources) {
    const layers = recipesFor(options.config, source)
    if (layers === undefined) {
      unmatched.push(source)
      continue
    }
    layers.forEach((layer, layerIndex) => {
      const label = recipeLabel(layer, layerIndex)
      const where = `${source.file.rel} / recipe ${label}`
      const recipe = resolveRecipe(options.config, layer, options.overrides, where)
      const isSvg = source.format === 'svg'
      const sourceDims = orientedSize(
        { width: source.rawWidth, height: source.rawHeight },
        source.orientation,
        recipe.autoOrient,
        recipe.rotate,
      )

      for (const format of outputFormats(recipe, source)) {
        const codec = resolveCodecOptions(format, recipe.layers)
        for (const spec of specsFor(recipe, sourceDims)) {
          const geometry = computeGeometry(
            sourceDims,
            spec.box,
            recipe.fit,
            recipe.withoutEnlargement && !isSvg,
          )
          const ops: Operations = {
            autoOrient: recipe.autoOrient,
            rotate: recipe.rotate,
            flip: recipe.flip,
            flop: recipe.flop,
            grayscale: recipe.grayscale,
            sharpen: recipe.sharpen,
            blur: recipe.blur,
            flatten: recipe.flatten ?? (format === 'jpg' ? '#ffffff' : undefined),
            metadata: recipe.metadata,
            fit: recipe.fit,
            position: recipe.position,
            background: recipe.background,
          }
          const values: TemplateValues = {
            name: source.file.base,
            ext: source.file.ext,
            format: FORMAT_EXTENSIONS[format],
            dir: options.flat ? '' : source.file.relDir,
            width: geometry.width,
            height: geometry.height,
            size: sizeLabel(geometry.width, geometry.height),
            long: Math.max(geometry.width, geometry.height),
            short: Math.min(geometry.width, geometry.height),
            mp:
              spec.requestedMp !== undefined
                ? requestedNumber(spec.requestedMp)
                : trimNumber((geometry.width * geometry.height) / 1_000_000),
            percent:
              spec.requestedPercent !== undefined
                ? requestedNumber(spec.requestedPercent)
                : String(Math.round((geometry.width / sourceDims.width) * 100)),
            scale: String(spec.scale),
            index: source.index,
            hash: source.hash,
            date,
            orig: source.file.orig,
          }
          const outRel =
            placement === 'replace'
              ? source.file.rel
              : expandTemplate(
                  recipe.explicitTemplate
                    ? recipe.template.tokens
                    : defaultTokensFor(spec.kind, spec.scale),
                  values,
                  where,
                )
          const outAbs =
            placement === 'replace'
              ? source.file.abs
              : placement === 'beside'
                ? join(source.file.root, ...outRel.split('/'))
                : join(options.outDir ?? '.', ...outRel.split('/'))
          const job: PlannedJob = {
            source,
            recipeLabel: label,
            outRel,
            outAbs,
            format,
            codec,
            width: geometry.width,
            height: geometry.height,
            geometry,
            ops,
            maxBytes: recipe.maxBytes,
            fingerprint: fingerprintOf(source, geometry, format, codec, ops, recipe.maxBytes),
            settingsKey: settingsKeyOf(
              spec,
              format,
              codec,
              ops,
              recipe.withoutEnlargement,
              recipe.maxBytes,
            ),
          }
          if (recipe.maxBytes !== undefined && !supportsQualityLimit(format, codec)) {
            throw new ImageBatchUsageError(
              `a size limit (maxBytes, --max-size) needs a format with a quality setting — jpg, webp, avif, heif, jp2, or png with a palette; "${source.file.rel}" would be written as ${format}`,
            )
          }
          const key = outRel.toLowerCase()
          const existing = claims.get(key)
          if (existing) {
            if (existing.some((other) => other.fingerprint === job.fingerprint)) {
              deduped += 1
              continue
            }
            existing.push(job)
          } else {
            claims.set(key, [job])
          }
          jobs.push(job)
        }
      }
    })
  }

  const collisions: Collision[] = []
  if (placement === 'replace') return { jobs, collisions, deduped, unmatched }
  for (const group of claims.values()) {
    if (group.length < 2) continue
    collisions.push({
      path: (group[0] as PlannedJob).outRel,
      sources: group.map((job) => job.source.file.rel),
      recipes: group.map((job) => job.recipeLabel),
      claims: group.map(
        (job) =>
          `${job.source.file.rel} → recipe ${job.recipeLabel}, ${job.format} ${job.width}×${job.height}${
            Object.keys(job.codec).length > 0 ? ` (${describeOptions(job.codec)})` : ''
          }`,
      ),
    })
  }

  const sourcePaths = new Map(
    options.sources.map((source) => [source.file.abs.toLowerCase(), source] as const),
  )
  for (const job of jobs) {
    const clash = sourcePaths.get(job.outAbs.toLowerCase())
    if (clash) {
      collisions.push({
        path: job.outRel,
        sources: [job.source.file.rel],
        recipes: [job.recipeLabel],
        claims: [
          `${job.source.file.rel} → recipe ${job.recipeLabel} would overwrite the source file ${clash.file.rel} (use --replace to change the originals on purpose)`,
        ],
      })
    }
  }

  return { jobs, collisions, deduped, unmatched }
}

const MAX_COLLISIONS_SHOWN = 6

export function validateReplacePlan(jobs: PlannedJob[]): void {
  const bySource = new Map<SourceInfo, PlannedJob[]>()
  for (const job of jobs) {
    const list = bySource.get(job.source)
    if (list) list.push(job)
    else bySource.set(job.source, [job])
  }
  for (const [source, list] of bySource) {
    const first = list[0] as PlannedJob
    if (list.length > 1) {
      const outputs = list.map(
        (job) => `${job.recipeLabel}: ${job.format} ${job.width}×${job.height}`,
      )
      throw new ImageBatchUsageError(
        `--replace writes one result over each image, but "${source.file.rel}" would get ${list.length} (${outputs.join('; ')}) — use one recipe with one size`,
      )
    }
    if (first.format !== source.format) {
      throw new ImageBatchUsageError(
        `--replace keeps each file's own format, but "${source.file.rel}" is ${source.format} and the recipe writes ${first.format} — leave "formats" out or use "original"`,
      )
    }
  }
}

export function describeCollisions(collisions: Collision[]): string {
  const shown = collisions.slice(0, MAX_COLLISIONS_SHOWN)
  const lines = shown.map((collision) => {
    const detail = collision.claims.map((claim) => `    - ${claim}`).join('\n')
    return `  ${collision.path}\n${detail}`
  })
  if (collisions.length > shown.length) {
    lines.push(`  … and ${collisions.length - shown.length} more`)
  }
  const sameRecipe = collisions.every((c) => new Set(c.recipes).size === 1)
  const differentSources = collisions.every((c) => new Set(c.sources).size > 1)
  const hint =
    sameRecipe && differentSources
      ? 'Different source files end up with the same name (they differ only by extension?). Add {ext} or {orig} to the name template, e.g. {dir}/{name}.{ext}-{width}w.{format}, or process one kind of file with --include.'
      : 'Add {width}, {format}, {scale} or {dir} to the name template, or separate the recipes.'
  return `the name templates produce the same output file more than once:\n${lines.join('\n')}\n  ${hint}`
}
