import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { Ignore, Options as IgnoreOptions } from 'ignore'

// `ignore` is CJS with no "exports" map in its package.json — under
// `moduleResolution: NodeNext` (which this project uses because it
// matches Node's actual runtime resolution, unlike "Bundler"), TS's
// default-export interop for exactly that shape of package breaks: `import
// ignore from 'ignore'` type-checks as the raw module namespace, not the
// callable factory (reproduced in isolation, not a config mistake here).
// Loading it via the real CJS loader sidesteps the broken interop
// entirely — arguably the more honest way to consume a CJS module from
// ESM anyway.
const require = createRequire(import.meta.url)
const ignore = require('ignore') as (options?: IgnoreOptions) => Ignore

// Every dev-toolz command that scans a tree agrees on this default —
// listed once here instead of copy-pasted per command. `--ignore` (per
// command) adds to this, it never has to re-list these.
//
// `.nuxt`/`.output`/`.next` — real dogfooding against vue-image-kit's
// `demo-nuxt/` (2026-09-25, empty-catch) found minified build output
// getting scanned as real source, producing nonsense findings at
// column 138282 in a single-line bundle. `.gitignore` support alone
// doesn't catch this: it only reads the root `<cwd>/.gitignore`, not a
// nested project's own one (`demo-nuxt` here has its own, several
// levels down) — so a framework's own well-known build-output
// directory name needs to be a hardcoded default, the same as
// `dist`/`build` already are, not left to `.gitignore` to catch.
const DEFAULT_IGNORES = [
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.nuxt',
  '.output',
  '.next',
]

export interface WalkOptions {
  cwd: string
  /** file extensions to include, each with its leading dot, e.g. ['.ts', '.vue'] */
  extensions: string[]
  /** extra gitignore-syntax patterns, on top of DEFAULT_IGNORES and the real .gitignore */
  ignoreGlobs?: string[]
  /** default true — also honor <cwd>/.gitignore, root-level only (see features.md case-check/walk caveats) */
  respectGitignore?: boolean
  /** default true — descend into subdirectories; false only lists files directly inside each given directory */
  recursive?: boolean
}

function buildMatcher(options: WalkOptions): Ignore {
  const matcher = ignore()
  matcher.add(DEFAULT_IGNORES)
  if (options.respectGitignore !== false) {
    try {
      const gitignoreText = readFileSync(join(options.cwd, '.gitignore'), 'utf8')
      matcher.add(gitignoreText)
    } catch {
      // no .gitignore at cwd root — nothing extra to add, not an error
    }
  }
  if (options.ignoreGlobs?.length) matcher.add(options.ignoreGlobs)
  return matcher
}

// `ignore` requires a path that's genuinely relative to its root (no `..`
// segments) and throws otherwise — true for everything under a normal
// `--cwd`-rooted scan, but a caller can point `walk()` at a path outside
// `--cwd` entirely (an unusual invocation, but not one that should crash).
// There's no `.gitignore`/`--ignore` rule that meaningfully applies
// outside the root they were read relative to, so falls back to just the
// hardcoded default-noise-directory names for anything out there.
function isIgnored(absPath: string, cwd: string, matcher: Ignore): boolean {
  const relPath = relative(cwd, absPath).split('\\').join('/')
  if (relPath === '') return false
  if (relPath.startsWith('..')) return DEFAULT_IGNORES.includes(basename(absPath))
  return matcher.ignores(relPath)
}

function walkDir(
  absDir: string,
  cwd: string,
  matcher: Ignore,
  extensions: Set<string>,
  out: string[],
  recursive: boolean,
): void {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const absPath = join(absDir, entry.name)
    if (isIgnored(absPath, cwd, matcher)) continue

    if (entry.isDirectory()) {
      if (recursive) walkDir(absPath, cwd, matcher, extensions, out, recursive)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      const ext = dot === -1 ? '' : entry.name.slice(dot)
      if (extensions.has(ext)) out.push(absPath)
    }
  }
}

/**
 * Resolves `inputPaths` (files and/or directories, as given on the CLI)
 * into a flat, deduplicated list of absolute file paths matching
 * `options.extensions` — directories are walked recursively, honoring
 * DEFAULT_IGNORES + the real `.gitignore` + any extra `--ignore` globs.
 * An explicitly-named file is included even if its extension wouldn't
 * otherwise match (the caller asked for it by name) but is still subject
 * to ignore-matching, so `--ignore` can still exclude it.
 */
export function walk(inputPaths: string[], options: WalkOptions): string[] {
  const matcher = buildMatcher(options)
  const extensions = new Set(options.extensions)
  const roots = inputPaths.length > 0 ? inputPaths : ['.']

  const out: string[] = []
  for (const inputPath of roots) {
    const absPath = resolve(options.cwd, inputPath)
    if (isIgnored(absPath, options.cwd, matcher)) continue

    const stat = statSync(absPath, { throwIfNoEntry: false })
    if (!stat) continue

    if (stat.isDirectory()) {
      walkDir(absPath, options.cwd, matcher, extensions, out, options.recursive !== false)
    } else if (stat.isFile()) {
      out.push(absPath)
    }
  }

  return [...new Set(out)]
}
