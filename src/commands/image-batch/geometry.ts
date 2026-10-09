import { ImageBatchUsageError } from './errors.js'

export const FIT_MODES = ['cover', 'contain', 'inside', 'outside', 'fill'] as const
export type Fit = (typeof FIT_MODES)[number]

export interface Dimensions {
  width: number
  height: number
}

export interface Box {
  width?: number
  height?: number
}

export interface Geometry extends Dimensions {
  resize: { width: number; height: number; fit: Fit } | null
}

const atLeastOne = (n: number) => Math.max(1, Math.round(n))

export function computeGeometry(
  source: Dimensions,
  box: Box,
  fit: Fit,
  withoutEnlargement: boolean,
): Geometry {
  const untouched: Geometry = { width: source.width, height: source.height, resize: null }
  const { width: boxWidth, height: boxHeight } = box

  if (boxWidth !== undefined && boxHeight === undefined) {
    if (withoutEnlargement && boxWidth >= source.width) return untouched
    const height = atLeastOne((source.height * boxWidth) / source.width)
    return { width: boxWidth, height, resize: { width: boxWidth, height, fit: 'fill' } }
  }
  if (boxHeight !== undefined && boxWidth === undefined) {
    if (withoutEnlargement && boxHeight >= source.height) return untouched
    const width = atLeastOne((source.width * boxHeight) / source.height)
    return { width, height: boxHeight, resize: { width, height: boxHeight, fit: 'fill' } }
  }
  if (boxWidth === undefined || boxHeight === undefined) return untouched

  if (fit === 'inside' || fit === 'outside') {
    const ratioX = boxWidth / source.width
    const ratioY = boxHeight / source.height
    let ratio = fit === 'inside' ? Math.min(ratioX, ratioY) : Math.max(ratioX, ratioY)
    if (withoutEnlargement && ratio >= 1) return untouched
    ratio = Math.max(ratio, 0)
    const width = atLeastOne(source.width * ratio)
    const height = atLeastOne(source.height * ratio)
    return { width, height, resize: { width, height, fit: 'fill' } }
  }

  let targetWidth = boxWidth
  let targetHeight = boxHeight
  if (withoutEnlargement && (boxWidth > source.width || boxHeight > source.height)) {
    const factor = Math.min(source.width / boxWidth, source.height / boxHeight)
    targetWidth = atLeastOne(boxWidth * factor)
    targetHeight = atLeastOne(boxHeight * factor)
  }
  return {
    width: targetWidth,
    height: targetHeight,
    resize: { width: targetWidth, height: targetHeight, fit },
  }
}

export function boxForLongEdge(dims: Dimensions, edge: number): Box {
  return dims.width >= dims.height ? { width: edge } : { height: edge }
}

export function boxForShortEdge(dims: Dimensions, edge: number): Box {
  return dims.width <= dims.height ? { width: edge } : { height: edge }
}

export function boxForMegapixels(dims: Dimensions, megapixels: number): Box {
  const factor = Math.sqrt((megapixels * 1_000_000) / (dims.width * dims.height))
  return { width: atLeastOne(dims.width * factor) }
}

export function boxForPercent(dims: Dimensions, percent: number): Box {
  return { width: atLeastOne((dims.width * percent) / 100) }
}

export function matchBoxOrientation(box: Required<Box>, dims: Dimensions): Required<Box> {
  const boxLandscape = box.width > box.height
  const boxPortrait = box.height > box.width
  const sourceLandscape = dims.width > dims.height
  const sourcePortrait = dims.height > dims.width
  if ((boxLandscape && sourcePortrait) || (boxPortrait && sourceLandscape)) {
    return { width: box.height, height: box.width }
  }
  return box
}

export function parseSize(text: string, where: string): Required<Box> {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(text.trim())
  const width = match ? Number(match[1]) : 0
  const height = match ? Number(match[2]) : 0
  if (!match || width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new ImageBatchUsageError(`${where}: expected a size like 800x600 (got "${text}")`)
  }
  return { width, height }
}

export function orientedSize(
  raw: Dimensions,
  orientation: number | undefined,
  autoOrient: boolean,
  rotate: number | undefined,
): Dimensions {
  let size: Dimensions = { width: raw.width, height: raw.height }
  if (autoOrient && (orientation ?? 1) >= 5) {
    size = { width: size.height, height: size.width }
  }
  if (rotate === 90 || rotate === 270) {
    size = { width: size.height, height: size.width }
  }
  return size
}

export function sizeLabel(width: number, height: number): string {
  return `${width}x${height}`
}
