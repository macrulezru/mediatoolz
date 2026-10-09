import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ImageHashUsageError } from './core.js'

export const SHARP_SPEC = 'sharp@^0.35.5'
export const MANAGED_DEPS_DIR = join(homedir(), '.mediatoolz', 'deps')

export interface RawImage {
  data: Uint8Array
  info: { width: number; height: number }
}

export interface SharpImage {
  metadata(): Promise<{ width?: number; height?: number; orientation?: number }>
  rotate(): SharpImage
  resize(options: {
    width: number
    height: number
    fit: 'inside'
    withoutEnlargement: boolean
  }): SharpImage
  toColourspace(colourspace: string): SharpImage
  ensureAlpha(): SharpImage
  raw(): SharpImage
  png(options?: { compressionLevel?: number }): SharpImage
  webp(options?: { quality?: number }): SharpImage
  toBuffer(): Promise<Uint8Array>
  toBuffer(options: { resolveWithObject: true }): Promise<RawImage>
}

export interface SharpInputOptions {
  failOn?: 'none' | 'truncated'
  limitInputPixels?: number | false
  raw?: { width: number; height: number; channels: 4 }
}

export interface SharpFactory {
  (input: string | Uint8Array, options?: SharpInputOptions): SharpImage
  cache?: (options: boolean) => unknown
}

export interface SharpLoaderDeps {
  resolveBundled: () => SharpFactory | null
  resolveFromCwd: (cwd: string) => SharpFactory | null
  resolveManaged: () => SharpFactory | null
  install: () => boolean
  confirm: (question: string) => Promise<boolean>
  interactive: boolean
}

function toFactory(loaded: unknown): SharpFactory {
  if (typeof loaded === 'function') return loaded as SharpFactory
  return (loaded as { default: SharpFactory }).default
}

function tryRequire(requireFrom: string): SharpFactory | null {
  try {
    return toFactory(createRequire(requireFrom)('sharp'))
  } catch {
    return null
  }
}

function installIntoManagedDir(): boolean {
  mkdirSync(MANAGED_DEPS_DIR, { recursive: true })
  const manifest = join(MANAGED_DEPS_DIR, 'package.json')
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({ name: 'mediatoolz-deps', private: true }, null, 2))
  }
  const result = spawnSync(
    'npm',
    ['install', SHARP_SPEC, '--prefix', MANAGED_DEPS_DIR, '--no-audit', '--no-fund'],
    { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' },
  )
  return result.status === 0
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  let answer: string
  try {
    answer = (await rl.question(`${question} [Y/n]: `)).trim().toLowerCase()
  } finally {
    rl.close()
  }
  return answer === '' || answer === 'y' || answer === 'yes'
}

export function defaultSharpLoaderDeps(): SharpLoaderDeps {
  return {
    resolveBundled: () => tryRequire(import.meta.url),
    resolveFromCwd: (cwd) => tryRequire(join(cwd, 'package.json')),
    resolveManaged: () => tryRequire(join(MANAGED_DEPS_DIR, 'package.json')),
    install: installIntoManagedDir,
    confirm: askYesNo,
    interactive: Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY),
  }
}

export async function loadSharp(
  options: {
    assumeYes?: boolean
    cwd?: string
    command?: string
    createError?: (message: string) => Error
  },
  deps: SharpLoaderDeps = defaultSharpLoaderDeps(),
): Promise<SharpFactory> {
  const existing =
    deps.resolveBundled() ??
    (options.cwd !== undefined ? deps.resolveFromCwd(options.cwd) : null) ??
    deps.resolveManaged()
  if (existing) return existing

  const command = options.command ?? 'image-hash'
  const fail = (message: string): Error =>
    options.createError ? options.createError(message) : new ImageHashUsageError(message)
  const manualHint = `Install it yourself with: npm install ${SHARP_SPEC}`
  if (!options.assumeYes) {
    if (!deps.interactive) {
      throw fail(
        `${command} needs the "sharp" image library, and it is not installed. ` +
          `Run with --yes to let mediatoolz install it into ${MANAGED_DEPS_DIR}. ${manualHint}`,
      )
    }
    const agreed = await deps.confirm(
      `${command} needs the "sharp" image library (native, ~30 MB). Install it into ${MANAGED_DEPS_DIR}?`,
    )
    if (!agreed) {
      throw fail(`"sharp" was not installed, nothing to do. ${manualHint}`)
    }
  }

  if (!deps.install()) {
    throw fail(`Installing "sharp" failed. ${manualHint}`)
  }
  const installed = deps.resolveManaged()
  if (!installed) {
    throw fail(`"sharp" was installed but could not be loaded on this platform. ${manualHint}`)
  }
  return installed
}
