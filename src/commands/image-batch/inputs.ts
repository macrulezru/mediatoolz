import { statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { hasGlobChars, literalPrefix, matchGlob } from '../../utils/glob.js'
import { walk } from '../../utils/walk.js'
import { DEFAULT_IMAGE_EXTENSIONS } from '../image-hash/core.js'
import { ImageBatchUsageError } from './errors.js'

export const BATCH_IMAGE_EXTENSIONS = [...DEFAULT_IMAGE_EXTENSIONS, '.svg']

export interface InputFile {
  abs: string
  root: string
  rel: string
  relDir: string
  base: string
  ext: string
  orig: string
}

export interface InputOptions {
  paths: string[]
  cwd: string
  recursive?: boolean
  extensions: string[]
  ignoreGlobs?: string[]
  respectGitignore?: boolean
  include?: string[]
  exclude?: string[]
  outDir?: string
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function describe(abs: string, root: string): InputFile {
  const rel = toPosix(relative(root, abs))
  const orig = basename(abs)
  const dot = extname(orig)
  const relDir = toPosix(dirname(rel))
  return {
    abs,
    root,
    rel,
    relDir: relDir === '.' ? '' : relDir,
    base: dot ? orig.slice(0, -dot.length) : orig,
    ext: dot.slice(1).toLowerCase(),
    orig,
  }
}

export function collectInputs(options: InputOptions): InputFile[] {
  const outDir = options.outDir !== undefined ? resolve(options.cwd, options.outDir) : undefined
  const walkBase = {
    cwd: options.cwd,
    extensions: options.extensions,
    ...(options.ignoreGlobs ? { ignoreGlobs: options.ignoreGlobs } : {}),
    ...(options.respectGitignore !== undefined
      ? { respectGitignore: options.respectGitignore }
      : {}),
  }
  const found = new Map<string, InputFile>()
  const add = (abs: string, root: string) => {
    if (!found.has(abs)) found.set(abs, describe(abs, root))
  }

  const paths = options.paths.length > 0 ? options.paths : ['.']
  for (const arg of paths) {
    const abs = resolve(options.cwd, arg)
    const stat = statSync(abs, { throwIfNoEntry: false })
    if (stat?.isDirectory()) {
      for (const file of walk([abs], { ...walkBase, recursive: options.recursive ?? false })) {
        add(file, abs)
      }
    } else if (stat?.isFile()) {
      add(abs, dirname(abs))
    } else if (hasGlobChars(arg)) {
      const prefix = literalPrefix(arg)
      const root = resolve(options.cwd, prefix === '' ? '.' : prefix)
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue
      const pattern = toPosix(arg).replace(/^\.\//, '')
      for (const file of walk([root], { ...walkBase, recursive: true })) {
        const subject = isAbsolute(arg) ? toPosix(file) : toPosix(relative(options.cwd, file))
        if (matchGlob(pattern, subject)) add(file, root)
      }
    } else {
      throw new ImageBatchUsageError(`path not found: ${arg}`)
    }
  }

  let files = [...found.values()]
  if (outDir !== undefined) {
    files = files.filter((file) => !isInside(outDir, file.abs))
  }
  if (options.include?.length) {
    const patterns = options.include
    files = files.filter((file) => patterns.some((pattern) => matchGlob(pattern, file.rel)))
  }
  if (options.exclude?.length) {
    const patterns = options.exclude
    files = files.filter((file) => !patterns.some((pattern) => matchGlob(pattern, file.rel)))
  }
  return files.sort((a, b) => a.abs.localeCompare(b.abs))
}
