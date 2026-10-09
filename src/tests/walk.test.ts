import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { walk } from '../utils/walk.js'

describe('walk', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mediatoolz-walk-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(relPath: string, content = ''): void {
    const full = join(root, relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  it('finds matching files recursively', () => {
    write('src/a.ts', '')
    write('src/nested/b.ts', '')
    write('src/c.txt', '')

    const files = walk(['.'], { cwd: root, extensions: ['.ts'] })
    expect(files.sort()).toEqual([join(root, 'src/a.ts'), join(root, 'src/nested/b.ts')].sort())
  })

  it('skips node_modules/dist/.git/build/coverage by default', () => {
    write('node_modules/pkg/index.ts', '')
    write('dist/out.ts', '')
    write('.git/hooks/x.ts', '')
    write('build/y.ts', '')
    write('coverage/z.ts', '')
    write('src/real.ts', '')

    const files = walk(['.'], { cwd: root, extensions: ['.ts'] })
    expect(files).toEqual([join(root, 'src/real.ts')])
  })

  it('skips .nuxt/.output/.next build-output directories by default — even a nested one without its own .gitignore reachable from cwd', () => {
    write('demo-nuxt/.nuxt/types/nuxt.d.ts', '')
    write('demo-nuxt/.output/server/chunk.mjs', '')
    write('demo-app/.next/static/chunk.js', '')
    write('src/real.ts', '')

    const files = walk(['.'], { cwd: root, extensions: ['.ts', '.js', '.mjs'] })
    expect(files).toEqual([join(root, 'src/real.ts')])
  })

  it('honors the real .gitignore at cwd root', () => {
    write('.gitignore', 'ignored-dir/\n')
    write('ignored-dir/a.ts', '')
    write('kept/b.ts', '')

    const files = walk(['.'], { cwd: root, extensions: ['.ts'] })
    expect(files).toEqual([join(root, 'kept/b.ts')])
  })

  it('does not honor .gitignore when respectGitignore is false', () => {
    write('.gitignore', 'ignored-dir/\n')
    write('ignored-dir/a.ts', '')

    const files = walk(['.'], { cwd: root, extensions: ['.ts'], respectGitignore: false })
    expect(files).toEqual([join(root, 'ignored-dir/a.ts')])
  })

  it('applies extra --ignore globs on top of the defaults', () => {
    write('skip-me/a.ts', '')
    write('keep-me/b.ts', '')

    const files = walk(['.'], { cwd: root, extensions: ['.ts'], ignoreGlobs: ['skip-me/'] })
    expect(files).toEqual([join(root, 'keep-me/b.ts')])
  })

  it('includes an explicitly-named file regardless of extension', () => {
    write('README.md', '')

    const files = walk(['README.md'], { cwd: root, extensions: ['.ts'] })
    expect(files).toEqual([join(root, 'README.md')])
  })

  it('does not crash on a target path outside cwd, and still skips default-noise dirs there', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mediatoolz-walk-outside-'))
    try {
      writeFileSync(join(outside, 'real.ts'), '')
      mkdirSync(join(outside, 'node_modules'), { recursive: true })
      writeFileSync(join(outside, 'node_modules', 'vendored.ts'), '')

      const files = walk([outside], { cwd: root, extensions: ['.ts'] })
      expect(files).toEqual([join(outside, 'real.ts')])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('deduplicates when the same file is reachable via two given roots', () => {
    write('src/a.ts', '')

    const files = walk(['src', 'src/a.ts'], { cwd: root, extensions: ['.ts'] })
    expect(files).toEqual([join(root, 'src/a.ts')])
  })
})
