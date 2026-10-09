import { decode as decodeBlurhash } from 'blurhash'
import { decode as decodeHazehash } from 'hazehash/decode'
import { thumbHashToRGBA } from 'thumbhash'

export interface Rgba {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type DecodableType = 'hazehash' | 'blurhash' | 'thumbhash'

const LONG_SIDE = 32

export function decodeBlur(hash: string, width: number, height: number): Rgba | null {
  const aspect = width > 0 && height > 0 ? width / height : 1
  const w = aspect >= 1 ? LONG_SIDE : Math.max(1, Math.round(LONG_SIDE * aspect))
  const h = aspect >= 1 ? Math.max(1, Math.round(LONG_SIDE / aspect)) : LONG_SIDE
  try {
    return { width: w, height: h, data: decodeBlurhash(hash, w, h) }
  } catch {
    return null
  }
}

export function decodeThumb(hash: string): Rgba | null {
  try {
    const binary = atob(hash)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const decoded = thumbHashToRGBA(bytes)
    return { width: decoded.w, height: decoded.h, data: new Uint8ClampedArray(decoded.rgba) }
  } catch {
    return null
  }
}

export function decodeHaze(hash: string): Rgba | null {
  try {
    const decoded = decodeHazehash(hash, { size: LONG_SIDE })
    return {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8ClampedArray(decoded.data),
    }
  } catch {
    return null
  }
}

export function decodePlaceholder(
  type: DecodableType,
  hash: string,
  width: number,
  height: number,
): Rgba | null {
  if (type === 'blurhash') return decodeBlur(hash, width, height)
  if (type === 'thumbhash') return decodeThumb(hash)
  return decodeHaze(hash)
}

export interface ResultEntry {
  file: string
  path: string
  width: number
  height: number
  hazehash?: string
  blurhash?: string
  thumbhash?: string
  color?: string
  preview?: string
}
