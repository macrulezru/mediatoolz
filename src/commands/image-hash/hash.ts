import { encode as encodeBlurhash } from 'blurhash'
import { encodeToString as encodeHazehash } from 'hazehash/encode'
import { rgbaToThumbHash, thumbHashToRGBA } from 'thumbhash'
import {
  DEFAULT_HAZEHASH_BUDGET,
  resolveComponents,
  type Components,
  type HashType,
} from './core.js'
import type { SharpFactory, SharpInputOptions } from './sharp-loader.js'

export interface ComputeOptions {
  types: HashType[]
  size: number
  components: Components
  budget?: number
  maxPixels?: number
}

export interface ComputedHashes {
  width: number
  height: number
  hazehash?: string
  blurhash?: string
  thumbhash?: string
  color?: string
  preview?: string
}

export function dominantColor(rgba: ArrayLike<number>): string | undefined {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] as number) < 128) continue
    const r = rgba[i] as number
    const g = rgba[i + 1] as number
    const b = rgba[i + 2] as number
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.count++
      bucket.r += r
      bucket.g += g
      bucket.b += b
    } else {
      buckets.set(key, { count: 1, r, g, b })
    }
  }
  let best: { count: number; r: number; g: number; b: number } | undefined
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket
  }
  if (!best) return undefined
  const hex = (sum: number) =>
    Math.round(sum / (best as { count: number }).count)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`
}

export function friendlyMessage(error: unknown, maxPixels: number | undefined): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/pixel limit/i.test(message)) {
    const limit = maxPixels === undefined ? 'the default limit' : `${maxPixels} pixels`
    return `image is larger than ${limit} — raise it with --max-pixels (0 removes the limit)`
  }
  if (/BudgetTooSmall/.test(message)) {
    return 'the hazehash --budget is too small for this image (an image with transparency needs at least 9 bytes)'
  }
  if (/unsupported image format|corrupt header|bad seek|not a known file format/i.test(message)) {
    return 'not a readable image — the file is corrupt or in an unsupported format'
  }
  if (/premature end|truncated|VipsJpeg|VipsPng|end of stream/i.test(message)) {
    return 'the image file is truncated or damaged'
  }
  return message
}

export async function computeHashes(
  sharp: SharpFactory,
  input: string | Uint8Array,
  options: ComputeOptions,
): Promise<ComputedHashes> {
  const inputOptions: SharpInputOptions = { failOn: 'truncated' }
  if (options.maxPixels !== undefined) {
    inputOptions.limitInputPixels = options.maxPixels === 0 ? false : options.maxPixels
  }

  const metadata = await sharp(input, inputOptions).metadata()
  const swapped = (metadata.orientation ?? 1) >= 5
  const width = (swapped ? metadata.height : metadata.width) ?? 0
  const height = (swapped ? metadata.width : metadata.height) ?? 0

  const { data, info } = await sharp(input, inputOptions)
    .rotate()
    .resize({ width: options.size, height: options.size, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const result: ComputedHashes = {
    width: width || info.width,
    height: height || info.height,
  }

  if (options.types.includes('hazehash')) {
    result.hazehash = encodeHazehash(
      { data, width: info.width, height: info.height },
      { budget: options.budget ?? DEFAULT_HAZEHASH_BUDGET },
    )
  }

  if (options.types.includes('blurhash')) {
    const components = resolveComponents(options.components, info.width, info.height)
    result.blurhash = encodeBlurhash(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      components.x,
      components.y,
    )
  }

  const needsThumbhash = options.types.includes('thumbhash') || options.types.includes('preview')
  if (needsThumbhash) {
    const hash = rgbaToThumbHash(info.width, info.height, data)
    if (options.types.includes('thumbhash')) {
      result.thumbhash = Buffer.from(hash).toString('base64')
    }
    if (options.types.includes('preview')) {
      const decoded = thumbHashToRGBA(hash)
      const png = await sharp(decoded.rgba, {
        raw: { width: decoded.w, height: decoded.h, channels: 4 },
      })
        .png({ compressionLevel: 9 })
        .toBuffer()
      result.preview = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
    }
  }

  if (options.types.includes('color')) {
    const color = dominantColor(data)
    if (color !== undefined) result.color = color
  }

  return result
}
