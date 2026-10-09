import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Sharp, SharpOptions } from 'sharp'
import { formatBytes } from '../../format/bytes.js'
import { qualityOf, sharpFormatName, toSharpOptions } from './codecs.js'
import type { PlannedJob, SharpFn } from './plan.js'
import { sharpenParams } from './sharpen.js'

export interface RenderOptions {
  maxPixels?: number
}

const MIN_DENSITY = 72
const MAX_DENSITY = 2400

function inputOptions(job: PlannedJob, options: RenderOptions): SharpOptions {
  const input: SharpOptions = { failOn: 'truncated' }
  if (options.maxPixels !== undefined) {
    input.limitInputPixels = options.maxPixels === 0 ? false : options.maxPixels
  }
  if (job.source.animated && (job.format === 'gif' || job.format === 'webp')) {
    input.animated = true
  }
  if (job.source.format === 'svg' && job.geometry.resize) {
    const ratio = job.geometry.resize.width / Math.max(1, job.source.rawWidth)
    input.density = Math.round(Math.min(MAX_DENSITY, Math.max(MIN_DENSITY, MIN_DENSITY * ratio)))
  }
  return input
}

export function buildPipeline(
  sharp: SharpFn,
  job: PlannedJob,
  buffer: Buffer,
  options: RenderOptions,
): Sharp {
  const { ops } = job
  let pipeline = sharp(buffer, inputOptions(job, options))

  if (ops.autoOrient) pipeline = pipeline.autoOrient()
  if (ops.rotate) pipeline = pipeline.rotate(ops.rotate)
  if (ops.flip) pipeline = pipeline.flip()
  if (ops.flop) pipeline = pipeline.flop()

  if (job.geometry.resize) {
    pipeline = pipeline.resize({
      width: job.geometry.resize.width,
      height: job.geometry.resize.height,
      fit: job.geometry.resize.fit,
      ...(ops.position ? { position: ops.position } : {}),
      background: ops.background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    })
  }

  if (ops.grayscale) pipeline = pipeline.grayscale()
  if (ops.sharpen !== undefined) pipeline = pipeline.sharpen(sharpenParams(ops.sharpen))
  if (ops.blur !== undefined) pipeline = pipeline.blur(ops.blur)
  if (ops.flatten !== undefined) {
    pipeline = pipeline.flatten({
      background: ops.flatten === true ? (ops.background ?? '#ffffff') : ops.flatten,
    })
  }

  if (ops.metadata === 'keep') pipeline = pipeline.keepMetadata()
  else if (ops.metadata === 'keep-icc') pipeline = pipeline.keepIccProfile()

  return pipeline.toFormat(
    sharpFormatName(job.format) as Parameters<Sharp['toFormat']>[0],
    toSharpOptions(job.codec),
  )
}

export async function renderJob(
  sharp: SharpFn,
  job: PlannedJob,
  buffer: Buffer,
  options: RenderOptions,
): Promise<Buffer> {
  const first = await buildPipeline(sharp, job, buffer, options).toBuffer()
  const limit = job.maxBytes
  if (limit === undefined || first.length <= limit) return first

  let low = 1
  let high = qualityOf(job.format, job.codec) - 1
  let best: Buffer | null = null
  let smallest = first.length
  while (low <= high) {
    const middle = (low + high) >> 1
    const attempt = { ...job, codec: { ...job.codec, quality: middle } }
    const data = await buildPipeline(sharp, attempt, buffer, options).toBuffer()
    smallest = Math.min(smallest, data.length)
    if (data.length <= limit) {
      best = data
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best) return best
  throw new Error(
    `could not get under ${formatBytes(limit)}: the smallest result is ${formatBytes(smallest)} even at the lowest quality — ask for a smaller size as well`,
  )
}

export function writeAtomic(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, data)
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
