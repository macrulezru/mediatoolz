import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from 'blurhash'
import { thumbHashToRGBA } from 'thumbhash'
import { runImageHash } from '../commands/image-hash/run.js'
import { renderImageHashReport } from '../commands/image-hash/report.js'
import {
  ImageHashUsageError,
  formatAggregate,
  formatPerFile,
  outputFileName,
  parseComponents,
  parseFormat,
  parseSampleSize,
  parseTypes,
  splitPathArguments,
  validateSuffix,
  type HashEntry,
} from '../commands/image-hash/core.js'
import {
  loadSharp,
  type SharpFactory,
  type SharpLoaderDeps,
} from '../commands/image-hash/sharp-loader.js'

type CreateImage = (options: unknown) => { toFile(path: string): Promise<unknown> }

const sharp = createRequire(import.meta.url)('sharp') as CreateImage

const entry: HashEntry = {
  file: 'img/a.jpg',
  width: 200,
  height: 100,
  blurhash: 'LEHV6nWB2yk8',
  thumbhash: 'YJqGPQw7',
}

describe('image-hash parsing', () => {
  it('parses types, formats, components and size', () => {
    expect(parseTypes('both')).toEqual(['blurhash', 'thumbhash'])
    expect(parseTypes('BlurHash')).toEqual(['blurhash'])
    expect(parseFormat('TS')).toBe('ts')
    expect(parseComponents('5x2')).toEqual({ x: 5, y: 2 })
    expect(parseSampleSize('64')).toBe(64)
  })

  it('rejects bad values with a usage error', () => {
    expect(() => parseTypes('md5')).toThrow(ImageHashUsageError)
    expect(() => parseFormat('xml')).toThrow(ImageHashUsageError)
    expect(() => parseComponents('10x3')).toThrow(ImageHashUsageError)
    expect(() => parseComponents('4')).toThrow(ImageHashUsageError)
    expect(() => parseSampleSize('101')).toThrow(ImageHashUsageError)
  })

  it('splits comma-separated paths but keeps an existing path containing a comma intact', () => {
    const exists = (p: string) => p === 'a,b.jpg'
    expect(splitPathArguments(['x.jpg,y.png', 'dir'], () => false)).toEqual([
      'x.jpg',
      'y.png',
      'dir',
    ])
    expect(splitPathArguments(['a,b.jpg'], exists)).toEqual(['a,b.jpg'])
  })

  it('requires {type} in the suffix when plain output holds both hashes', () => {
    expect(() => validateSuffix('.hash', ['blurhash', 'thumbhash'], 'plain')).toThrow(
      ImageHashUsageError,
    )
    expect(validateSuffix('.hash', ['blurhash'], 'plain')).toBe('.hash')
    expect(validateSuffix(undefined, ['blurhash', 'thumbhash'], 'plain')).toBe('.{type}')
  })
})

describe('image-hash formatting', () => {
  const both = ['blurhash', 'thumbhash'] as const

  it('formats aggregated json keyed by file', () => {
    const out = JSON.parse(formatAggregate([entry], [...both], 'json', 'x'))
    expect(out['img/a.jpg']).toEqual({
      width: 200,
      height: 100,
      blurhash: 'LEHV6nWB2yk8',
      thumbhash: 'YJqGPQw7',
    })
  })

  it('formats ts/js modules with the given export name', () => {
    expect(formatAggregate([entry], ['blurhash'], 'ts', 'photos')).toMatch(
      /^export const photos = \{[\s\S]*\} as const\n$/,
    )
    expect(formatAggregate([entry], ['blurhash'], 'js', 'photos')).not.toContain('as const')
  })

  it('formats csv and quotes fields that need it', () => {
    const csv = formatAggregate([{ ...entry, blurhash: 'a,"b' }], ['blurhash'], 'csv', 'x')
    expect(csv).toBe('file,width,height,blurhash\nimg/a.jpg,200,100,"a,""b"\n')
  })

  it('writes just the hash text per type in plain per-file mode, without a trailing newline', () => {
    expect(formatPerFile(entry, [...both], 'plain')).toEqual([
      { token: 'blurhash', content: 'LEHV6nWB2yk8' },
      { token: 'thumbhash', content: 'YJqGPQw7' },
    ])
  })

  it('writes one structured file per image using the "hash" token for both types', () => {
    const units = formatPerFile(entry, [...both], 'json')
    expect(units).toHaveLength(1)
    expect(units[0]?.token).toBe('hash')
  })

  it('builds output names from the full image file name', () => {
    expect(outputFileName('/p/photo.jpg', '.{type}', 'blurhash', '.txt')).toBe(
      'photo.jpg.blurhash.txt',
    )
    expect(outputFileName('/p/photo.jpg', '-ph', 'x', '.json')).toBe('photo.jpg-ph.json')
  })
})

describe('runImageHash', () => {
  let root: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mediatoolz-image-hash-'))
    mkdirSync(join(root, 'img', 'nested'), { recursive: true })
    const make = (width: number, height: number, r: number, g: number, b: number) =>
      sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha: 1 } } })
    await make(200, 100, 255, 0, 0).toFile(join(root, 'img', 'red.jpg'))
    await make(50, 80, 0, 0, 255).toFile(join(root, 'img', 'blue.png'))
    await make(30, 30, 0, 200, 0).toFile(join(root, 'img', 'nested', 'green.webp'))
    writeFileSync(join(root, 'img', 'readme.txt'), 'not an image')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('hashes only the top level of a directory without --recursive', async () => {
    const report = await runImageHash({ paths: ['img'], cwd: root, types: ['blurhash'] })
    expect(report.entries.map((e) => e.file)).toEqual(['img/blue.png', 'img/red.jpg'])
    expect(report.exitCode).toBe(0)
  })

  it('walks subdirectories with --recursive and reports real dimensions', async () => {
    const report = await runImageHash({
      paths: ['img'],
      cwd: root,
      types: ['blurhash', 'thumbhash'],
      recursive: true,
    })
    expect(report.entries.map((e) => e.file)).toEqual([
      'img/blue.png',
      'img/nested/green.webp',
      'img/red.jpg',
    ])
    const red = report.entries.find((e) => e.file === 'img/red.jpg')
    expect(red).toMatchObject({ width: 200, height: 100 })
    expect(() => decode(red?.blurhash ?? '', 8, 8)).not.toThrow()
    const decoded = thumbHashToRGBA(Buffer.from(red?.thumbhash ?? '', 'base64'))
    expect(decoded.rgba[0]).toBeGreaterThan(200)
    expect(report.stdout).toContain('"img/red.jpg"')
  })

  it('accepts a comma-separated mix of files and directories', async () => {
    const report = await runImageHash({
      paths: ['img/red.jpg,img/nested'],
      cwd: root,
      types: ['thumbhash'],
    })
    expect(report.entries.map((e) => e.file)).toEqual(['img/nested/green.webp', 'img/red.jpg'])
    expect(report.entries.every((e) => e.blurhash === undefined)).toBe(true)
  })

  it('writes one aggregated file with --out', async () => {
    const report = await runImageHash({
      paths: ['img'],
      cwd: root,
      types: ['blurhash'],
      out: 'out/hashes.json',
    })
    expect(report.stdout).toBeNull()
    expect(report.written).toEqual(['out/hashes.json'])
    const parsed = JSON.parse(readFileSync(join(root, 'out', 'hashes.json'), 'utf8'))
    expect(Object.keys(parsed)).toEqual(['img/blue.png', 'img/red.jpg'])
  })

  it('writes a plain text file per hash next to the image', async () => {
    const report = await runImageHash({
      paths: ['img/red.jpg'],
      cwd: root,
      types: ['blurhash', 'thumbhash'],
      format: 'plain',
      perFile: true,
    })
    expect([...report.written].sort()).toEqual([
      'img/red.jpg.blurhash.txt',
      'img/red.jpg.thumbhash.txt',
    ])
    const text = readFileSync(join(root, 'img', 'red.jpg.blurhash.txt'), 'utf8')
    expect(text).toBe(report.entries[0]?.blurhash)
  })

  it('honors a custom suffix and extension, and mirrors the tree into --out-dir', async () => {
    const report = await runImageHash({
      paths: ['img'],
      cwd: root,
      types: ['blurhash'],
      recursive: true,
      format: 'plain',
      outDir: 'hashes',
      suffix: '.bh',
      outExtension: 'hash',
    })
    expect([...report.written].sort()).toEqual([
      'hashes/blue.png.bh.hash',
      'hashes/nested/green.webp.bh.hash',
      'hashes/red.jpg.bh.hash',
    ])
    expect(existsSync(join(root, 'img', 'red.jpg.bh.hash'))).toBe(false)
  })

  it('writes a ts module with --format ts', async () => {
    await runImageHash({
      paths: ['img/red.jpg'],
      cwd: root,
      types: ['blurhash'],
      format: 'ts',
      exportName: 'placeholders',
      out: 'placeholders.ts',
    })
    const text = readFileSync(join(root, 'placeholders.ts'), 'utf8')
    expect(text.startsWith('export const placeholders = {')).toBe(true)
    expect(text.trimEnd().endsWith('as const')).toBe(true)
  })

  it('reports a missing path and an undecodable file as problems with exit code 1', async () => {
    writeFileSync(join(root, 'img', 'broken.jpg'), 'definitely not a jpeg')
    const report = await runImageHash({
      paths: ['img/broken.jpg', 'nope'],
      cwd: root,
      types: ['blurhash'],
    })
    expect(report.entries).toEqual([])
    expect(report.errors.map((e) => e.file).sort()).toEqual(['img/broken.jpg', 'nope'])
    expect(report.exitCode).toBe(1)
  })

  it('writes nothing with --dry-run, lists what would be written and shows a table', async () => {
    const report = await runImageHash({
      paths: ['img'],
      cwd: root,
      types: ['blurhash', 'thumbhash'],
      format: 'plain',
      perFile: true,
      dryRun: true,
    })
    expect(report.dryRun).toBe(true)
    expect(report.written).toContain('img/red.jpg.blurhash.txt')
    expect(existsSync(join(root, 'img', 'red.jpg.blurhash.txt'))).toBe(false)

    const text = renderImageHashReport(report, { plain: true })
    expect(text).toContain('│ File')
    expect(text).toContain('BlurHash')
    expect(text).toContain('ThumbHash')
    expect(text).toContain('200×100')
    expect(text).toContain('Would write')
    expect(text).toContain('dry run — nothing written')
  })

  it('does not write the --out file and does not print data on --dry-run', async () => {
    const report = await runImageHash({
      paths: ['img'],
      cwd: root,
      types: ['blurhash'],
      out: 'hashes.json',
      dryRun: true,
    })
    expect(existsSync(join(root, 'hashes.json'))).toBe(false)
    expect(report.written).toEqual(['hashes.json'])
    expect(report.stdout).toBeNull()
  })

  it('shows only the requested hash columns in the table', async () => {
    const report = await runImageHash({
      paths: ['img/red.jpg'],
      cwd: root,
      types: ['thumbhash'],
      dryRun: true,
    })
    const text = renderImageHashReport(report, { plain: true })
    expect(text).toContain('ThumbHash')
    expect(text).not.toContain('BlurHash')
  })

  it('refuses --out together with --per-file', async () => {
    await expect(
      runImageHash({
        paths: ['img'],
        cwd: root,
        types: ['blurhash'],
        out: 'a.json',
        perFile: true,
      }),
    ).rejects.toThrow(ImageHashUsageError)
  })

  it('keeps going when one image of many is broken', async () => {
    writeFileSync(join(root, 'img', 'broken.jpg'), 'nope')
    const report = await runImageHash({ paths: ['img'], cwd: root, types: ['blurhash'] })
    expect(report.entries.map((e) => e.file)).toEqual(['img/blue.png', 'img/red.jpg'])
    expect(report.errors).toHaveLength(1)
    expect(report.exitCode).toBe(1)
  })
})

describe('loadSharp', () => {
  const fake = (() => ({})) as unknown as SharpFactory

  function deps(overrides: Partial<SharpLoaderDeps>): SharpLoaderDeps {
    return {
      resolveBundled: () => null,
      resolveFromCwd: () => null,
      resolveManaged: () => null,
      install: () => true,
      confirm: async () => true,
      interactive: true,
      ...overrides,
    }
  }

  it('returns an already-installed sharp without asking anything', async () => {
    let asked = false
    const result = await loadSharp(
      {},
      deps({
        resolveBundled: () => fake,
        confirm: async () => {
          asked = true
          return true
        },
      }),
    )
    expect(result).toBe(fake)
    expect(asked).toBe(false)
  })

  it('finds a sharp installed in the project the command runs in, before offering an install', async () => {
    let asked = false
    const seen: string[] = []
    const result = await loadSharp(
      { cwd: '/my/project' },
      deps({
        resolveFromCwd: (cwd) => {
          seen.push(cwd)
          return fake
        },
        confirm: async () => {
          asked = true
          return true
        },
      }),
    )
    expect(result).toBe(fake)
    expect(seen).toEqual(['/my/project'])
    expect(asked).toBe(false)
  })

  it('installs after the user agrees, then loads the managed copy', async () => {
    let installed = false
    const result = await loadSharp(
      {},
      deps({
        install: () => {
          installed = true
          return true
        },
        resolveManaged: () => (installed ? fake : null),
      }),
    )
    expect(result).toBe(fake)
  })

  it('stops with a usage error when the user declines', async () => {
    let installed = false
    await expect(
      loadSharp(
        {},
        deps({
          confirm: async () => false,
          install: () => {
            installed = true
            return true
          },
        }),
      ),
    ).rejects.toThrow(ImageHashUsageError)
    expect(installed).toBe(false)
  })

  it('does not prompt without a terminal unless --yes was given', async () => {
    await expect(loadSharp({}, deps({ interactive: false }))).rejects.toThrow(/--yes/)
    let installed = false
    const result = await loadSharp(
      { assumeYes: true },
      deps({
        interactive: false,
        install: () => {
          installed = true
          return true
        },
        resolveManaged: () => (installed ? fake : null),
      }),
    )
    expect(result).toBe(fake)
  })

  it('reports a failed install', async () => {
    await expect(loadSharp({ assumeYes: true }, deps({ install: () => false }))).rejects.toThrow(
      /failed/,
    )
  })
})
