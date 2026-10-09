import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sharp, SharpOptions } from 'sharp'
import { parseConfig } from '../commands/image-batch/config.js'
import { ImageBatchUsageError } from '../commands/image-batch/errors.js'
import type { ConflictAnswer, ConflictInfo } from '../commands/image-batch/overwrite.js'
import type { SharpFn } from '../commands/image-batch/plan.js'
import { renderImageBatchReport } from '../commands/image-batch/report.js'
import { runImageBatch, type ImageBatchOptions } from '../commands/image-batch/run.js'

const sharp = createRequire(import.meta.url)('sharp') as SharpFn &
  ((input: unknown, options?: SharpOptions) => Sharp)

let root: string
let input: string
let output: string

async function photo(path: string, width: number, height: number, alpha = false): Promise<void> {
  const channels = alpha ? 4 : 3
  const data = Buffer.alloc(width * height * channels)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels
      data[o] = Math.round((x / width) * 255)
      data[o + 1] = (x * 7 + y * 3) % 256
      data[o + 2] = Math.round((y / height) * 255)
      if (alpha) data[o + 3] = x < width / 2 ? 255 : 0
    }
  }
  mkdirSync(join(path, '..'), { recursive: true })
  await sharp(data, { raw: { width, height, channels } }).png().toFile(path)
}

async function meta(path: string) {
  return sharp(readFileSync(path)).metadata()
}

function run(config: unknown, options: Partial<ImageBatchOptions> = {}) {
  return runImageBatch({
    paths: [input],
    cwd: root,
    out: output,
    recursive: true,
    config: parseConfig(config),
    interactive: false,
    cacheBase: root,
    ...options,
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ib-run-'))
  input = join(root, 'in')
  output = join(root, 'out')
  await photo(join(input, 'a.png'), 1200, 800)
  await photo(join(input, 'sub', 'b.png'), 600, 900, true)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('sizes and formats', () => {
  it('produces every size × format with the planned names and real dimensions', async () => {
    const report = await run({
      outputs: [{ widths: [400, 800], formats: ['webp', 'jpg', 'avif'] }],
    })
    expect(report.exitCode).toBe(0)
    expect(report.counts.written).toBe(12)
    for (const [name, format, w, h] of [
      ['a-400w.webp', 'webp', 400, 267],
      ['a-800w.jpg', 'jpeg', 800, 533],
      ['sub/b-400w.avif', 'heif', 400, 600],
      ['sub/b-600w.webp', 'webp', 600, 900],
    ] as const) {
      const info = await meta(join(output, name))
      expect(info.format, name).toBe(format)
      expect([info.width, info.height], name).toEqual([w, h])
    }
  })

  it('reports the exact dimensions it planned', async () => {
    const report = await run({ outputs: [{ widths: [333], formats: ['png'] }] })
    for (const result of report.results) {
      const info = await meta(join(output, result.output))
      expect([info.width, info.height]).toEqual([result.width, result.height])
    }
  })

  it('merges requested sizes above the source size into one file', async () => {
    const report = await run({ outputs: [{ widths: [400, 800, 1600], formats: ['webp'] }] })
    expect(report.deduped).toBe(1)
    expect(report.results.filter((r) => r.source === 'sub/b.png').map((r) => r.output)).toEqual([
      'sub/b-400w.webp',
      'sub/b-600w.webp',
    ])
  })

  it('upsizes when withoutEnlargement is off', async () => {
    await run({ outputs: [{ widths: [2000], formats: ['jpg'], withoutEnlargement: false }] })
    expect((await meta(join(output, 'a-2000w.jpg'))).width).toBe(2000)
  })

  it('keeps the original size and format when the recipe is empty', async () => {
    const report = await run({ outputs: [{}] })
    expect(report.results.map((r) => r.output)).toEqual(['a.png', 'sub/b.png'])
    expect((await meta(join(output, 'a.png'))).width).toBe(1200)
  })

  it('works without a config at all', async () => {
    const report = await runImageBatch({
      paths: [input],
      cwd: root,
      out: output,
      recursive: true,
      interactive: false,
      cacheBase: root,
      overrides: { widths: [300], formats: ['webp'] },
    })
    expect(report.results.map((r) => r.output)).toEqual(['a-300w.webp', 'sub/b-300w.webp'])
  })

  it('writes density variants with scale', async () => {
    const report = await run({
      outputs: [
        { widths: [300], scale: [1, 2], formats: ['webp'], name: '{name}@{scale}x.{format}' },
      ],
    })
    expect(report.results.map((r) => r.output)).toContain('a@2x.webp')
    expect((await meta(join(output, 'a@2x.webp'))).width).toBe(600)
  })

  it('applies per-recipe overrides from flags to every recipe', async () => {
    const report = await run(
      {
        outputs: [
          { widths: [100], formats: ['png'] },
          { widths: [200], formats: ['png'], name: 'x/{name}-{width}.{format}' },
        ],
      },
      { overrides: { formats: ['webp'] } },
    )
    expect(new Set(report.results.map((r) => r.format))).toEqual(new Set(['webp']))
  })

  it('picks a recipe by path with match rules, and reports files no rule covers', async () => {
    const report = await run({
      match: [{ glob: 'sub/**', outputs: [{ widths: [100], formats: ['png'] }] }],
    })
    expect(report.results.map((r) => r.output)).toEqual(['sub/b-100w.png'])
    expect(report.unmatched).toEqual(['a.png'])
  })

  it('uses {index}, {hash}, {dir} and --flat', async () => {
    const report = await run(
      { outputs: [{ formats: ['jpg'], name: '{dir}/{index:3}-{name}.{hash:6}.{format}' }] },
      { flat: true },
    )
    const names = report.results.map((r) => r.output)
    expect(names[0]).toMatch(/^001-a\.[0-9a-f]{6}\.jpg$/)
    expect(names[1]).toMatch(/^002-b\.[0-9a-f]{6}\.jpg$/)
  })
})

describe('geometry and operations', () => {
  it('cover crops to the exact box, contain letterboxes with the background', async () => {
    await run({
      outputs: [
        { size: '200x200', fit: 'cover', formats: ['png'], name: 'cover/{name}.{format}' },
        {
          size: '200x200',
          fit: 'contain',
          background: '#ff0000',
          formats: ['png'],
          name: 'contain/{name}.{format}',
        },
      ],
    })
    expect((await meta(join(output, 'cover/a.png'))).width).toBe(200)
    expect((await meta(join(output, 'cover/a.png'))).height).toBe(200)
    const raw = await sharp(readFileSync(join(output, 'contain/a.png')))
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([raw.info.width, raw.info.height]).toEqual([200, 200])
    expect([raw.data[0], raw.data[1], raw.data[2]]).toEqual([255, 0, 0])
  })

  it('flattens transparency onto white for jpg by default and onto a color on request', async () => {
    await run({
      outputs: [
        { formats: ['jpg'], name: 'w/{dir}/{name}.{format}' },
        { formats: ['jpg'], flatten: '#00ff00', name: 'g/{dir}/{name}.{format}' },
      ],
    })
    const pixel = async (name: string) => {
      const { data, info } = await sharp(readFileSync(join(output, name)))
        .raw()
        .toBuffer({ resolveWithObject: true })
      const at = ((info.height / 2) * info.width + (info.width - 5)) * info.channels
      return [data[at], data[at + 1], data[at + 2]]
    }
    const white = await pixel('w/sub/b.jpg')
    expect(white.every((v) => (v as number) > 245)).toBe(true)
    const green = await pixel('g/sub/b.jpg')
    expect((green[1] as number) > 240 && (green[0] as number) < 20).toBe(true)
  })

  it('rotates by a quarter turn and swaps the planned dimensions', async () => {
    const report = await run({ outputs: [{ rotate: 90, widths: [300], formats: ['png'] }] })
    const a = report.results.find((r) => r.source === 'a.png')
    expect([a?.width, a?.height]).toEqual([300, 450])
    const info = await meta(join(output, 'a-300w.png'))
    expect([info.width, info.height]).toEqual([300, 450])
  })

  it('applies EXIF orientation by default and leaves it alone when told to', async () => {
    const tall = join(input, 'exif.jpg')
    await sharp(Buffer.alloc(400 * 200 * 3, 120), { raw: { width: 400, height: 200, channels: 3 } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(tall)
    const on = await run({ outputs: [{ formats: ['png'], name: 'on/{name}.{format}' }] })
    const result = on.results.find((r) => r.source === 'exif.jpg')
    expect([result?.width, result?.height]).toEqual([200, 400])
    expect((await meta(join(output, 'on/exif.png'))).height).toBe(400)
    const off = await run(
      { outputs: [{ formats: ['png'], autoOrient: false, name: 'off/{name}.{format}' }] },
      { force: true },
    )
    const raw = off.results.find((r) => r.source === 'exif.jpg')
    expect([raw?.width, raw?.height]).toEqual([400, 200])
  })

  it('renders an svg crisply at a size above its own', async () => {
    writeFileSync(
      join(input, 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="25"><rect width="50" height="25" fill="#123456"/></svg>',
    )
    const report = await run(
      { outputs: [{ widths: [400], formats: ['png'] }] },
      { overrides: undefined },
    )
    const svg = report.results.find((r) => r.source === 'logo.svg')
    expect([svg?.width, svg?.height]).toEqual([400, 200])
    const info = await meta(join(output, 'logo-400w.png'))
    expect([info.width, info.height]).toEqual([400, 200])
  })

  it('keeps an animated gif animated', async () => {
    const frames = Buffer.concat([Buffer.alloc(40 * 40 * 3, 10), Buffer.alloc(40 * 40 * 3, 200)])
    await sharp(frames, { raw: { width: 40, height: 80, channels: 3, pageHeight: 40 } as never })
      .gif()
      .toFile(join(input, 'anim.gif'))
    const source = await meta(join(input, 'anim.gif'))
    if ((source.pages ?? 1) < 2) return
    await run({ outputs: [{ widths: [20], formats: ['gif'] }] })
    expect(
      (
        await sharp(readFileSync(join(output, 'anim-20w.gif')), {
          animated: true,
        } as never).metadata()
      ).pages,
    ).toBe(2)
  })
})

describe('codec options', () => {
  it('quality changes the size of a jpg', async () => {
    await run({
      outputs: [
        { formats: { jpg: { quality: 30 } }, name: 'low/{name}.{format}' },
        { formats: { jpg: { quality: 95 } }, name: 'high/{name}.{format}' },
      ],
    })
    expect(statSync(join(output, 'low/a.jpg')).size).toBeLessThan(
      statSync(join(output, 'high/a.jpg')).size,
    )
  })

  it('quality levels resolve per format', async () => {
    await run({
      outputs: [
        { formats: ['webp'], quality: 'low', name: 'l/{name}.{format}' },
        { formats: ['webp'], quality: 'best', name: 'b/{name}.{format}' },
      ],
    })
    expect(statSync(join(output, 'l/a.webp')).size).toBeLessThan(
      statSync(join(output, 'b/a.webp')).size,
    )
  })

  it('png palette makes a smaller file than the default', async () => {
    await run({
      outputs: [
        { formats: ['png'], name: 'full/{name}.{format}' },
        { formats: { png: { palette: true, colors: 16 } }, name: 'pal/{name}.{format}' },
      ],
    })
    expect(statSync(join(output, 'pal/a.png')).size).toBeLessThan(
      statSync(join(output, 'full/a.png')).size,
    )
  })

  it('webp lossless keeps every pixel', async () => {
    await run({
      outputs: [{ formats: { webp: { lossless: true } }, name: 'lossless/{name}.{format}' }],
    })
    const decode = async (path: string) =>
      (await sharp(readFileSync(path)).raw().toBuffer({ resolveWithObject: true })).data
    const original = await decode(join(input, 'a.png'))
    const roundTrip = await decode(join(output, 'lossless/a.webp'))
    expect(roundTrip.equals(original)).toBe(true)
  })

  it('writes avif and tiff with their options', async () => {
    const report = await run({
      outputs: [
        {
          widths: [200],
          formats: { avif: { quality: 30, effort: 2 }, tiff: { compression: 'lzw' } },
        },
      ],
    })
    expect(report.counts.error).toBe(0)
    expect((await meta(join(output, 'a-200w.tiff'))).format).toBe('tiff')
    expect((await meta(join(output, 'a-200w.avif'))).format).toBe('heif')
  })

  it('writes a heif container with the av1 compression by default', async () => {
    const report = await run({ outputs: [{ widths: [100], formats: ['heif'] }] })
    expect(report.counts.error).toBe(0)
    expect(existsSync(join(output, 'a-100w.heif'))).toBe(true)
  })

  it('names the format when this sharp build cannot write it, before writing anything', async () => {
    const supported =
      (sharp as unknown as { format: Record<string, unknown> }).format.jp2k !== undefined
    if (supported) return
    await expect(run({ outputs: [{ widths: [100], formats: ['jp2'] }] })).rejects.toThrow(
      /cannot write jp2/,
    )
    expect(existsSync(output)).toBe(false)
  })

  it('fails the planning, not the run, on a bad option', () => {
    expect(() => parseConfig({ outputs: [{ formats: { jpg: { effort: 3 } } }] })).toThrow(
      ImageBatchUsageError,
    )
  })
})

describe('planning errors', () => {
  it('stops before writing anything when two outputs collide', async () => {
    await expect(
      run({ outputs: [{ widths: [100, 200], formats: ['png'], name: '{name}.{format}' }] }),
    ).rejects.toThrow(/same output file more than once/)
    expect(existsSync(output)).toBe(false)
  })

  it('names the colliding claims', async () => {
    await expect(
      run({
        outputs: [
          { widths: [100], formats: ['png'], name: 'same.png' },
          { widths: [200], formats: ['png'], name: 'same.png' },
        ],
      }),
    ).rejects.toThrow(/same\.png[\s\S]*recipe #1[\s\S]*recipe #2/)
  })

  it('suggests {ext} when two source files differ only by extension', async () => {
    await sharp(Buffer.alloc(100 * 100 * 3, 50), { raw: { width: 100, height: 100, channels: 3 } })
      .webp()
      .toFile(join(input, 'a.webp'))
    await expect(run({ outputs: [{ widths: [50], formats: ['png'] }] })).rejects.toThrow(
      /differ only by extension[^]*[{]ext[}]/,
    )
  })

  it('shortens a long list of collisions', async () => {
    for (let i = 0; i < 9; i++) {
      await photo(join(input, `dup${i}.png`), 50, 50)
      await sharp(Buffer.alloc(50 * 50 * 3, 50), { raw: { width: 50, height: 50, channels: 3 } })
        .webp()
        .toFile(join(input, `dup${i}.webp`))
    }
    await expect(run({ outputs: [{ formats: ['png'] }] })).rejects.toThrow(/and [0-9]+ more/)
  })

  it('refuses to overwrite a source file', async () => {
    await expect(
      runImageBatch({
        paths: [input],
        cwd: root,
        out: input,
        recursive: true,
        config: parseConfig({ outputs: [{ formats: ['png'], name: '{name}.png' }] }),
        interactive: false,
        cacheBase: root,
      }),
    ).resolves.toBeDefined()
  })

  it('needs an output folder', async () => {
    await expect(runImageBatch({ paths: [input], cwd: root, interactive: false })).rejects.toThrow(
      /--out/,
    )
  })

  it('rejects a missing path', async () => {
    await expect(run({ outputs: [{}] }, { paths: [join(root, 'nope')] })).rejects.toThrow(
      /path not found/,
    )
  })

  it('needs --emit for placeholder flags', async () => {
    await expect(run({ outputs: [{}] }, { placeholders: { types: ['hazehash'] } })).rejects.toThrow(
      /--emit/,
    )
  })
})

describe('existing files, the cache and overwrite decisions', () => {
  const config = { outputs: [{ widths: [300], formats: ['webp'] }] }

  it('skips what an earlier run already made', async () => {
    await run(config)
    const again = await run(config)
    expect(again.counts['up-to-date']).toBe(2)
    expect(again.counts.written).toBe(0)
    expect(again.exitCode).toBe(0)
  })

  it('regenerates when the source changes, asking about the conflict', async () => {
    await run(config)
    await photo(join(input, 'a.png'), 1200, 801)
    const asked: ConflictInfo[] = []
    const report = await run(config, {
      overwrite: 'ask',
      prompt: async (info) => {
        asked.push(info)
        return 'yes'
      },
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ outRel: 'a-300w.webp', reason: 'changed' })
    expect(report.counts.written).toBe(1)
    expect(report.counts['up-to-date']).toBe(1)
  })

  it('tells a foreign file from one the command made', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-300w.webp'), 'not mine')
    const asked: ConflictInfo[] = []
    await run(config, {
      overwrite: 'ask',
      prompt: async (info) => {
        asked.push(info)
        return 'yes'
      },
    })
    expect(asked[0]?.reason).toBe('unknown')
  })

  it('"all" answers once and applies to every later conflict', async () => {
    mkdirSync(join(output, 'sub'), { recursive: true })
    writeFileSync(join(output, 'a-300w.webp'), 'x')
    writeFileSync(join(output, 'sub/b-300w.webp'), 'x')
    let asks = 0
    const report = await run(config, {
      overwrite: 'ask',
      prompt: async () => {
        asks += 1
        return 'all'
      },
    })
    expect(asks).toBe(1)
    expect(report.counts.written).toBe(2)
  })

  it('"none" skips this and every later conflict', async () => {
    mkdirSync(join(output, 'sub'), { recursive: true })
    writeFileSync(join(output, 'a-300w.webp'), 'x')
    writeFileSync(join(output, 'sub/b-300w.webp'), 'x')
    let asks = 0
    const report = await run(config, {
      overwrite: 'ask',
      prompt: async () => {
        asks += 1
        return 'none'
      },
    })
    expect(asks).toBe(1)
    expect(report.counts.skipped).toBe(2)
    expect(readFileSync(join(output, 'a-300w.webp'), 'utf8')).toBe('x')
  })

  it('"yes" and "skip" decide only for the file asked about', async () => {
    mkdirSync(join(output, 'sub'), { recursive: true })
    writeFileSync(join(output, 'a-300w.webp'), 'x')
    writeFileSync(join(output, 'sub/b-300w.webp'), 'x')
    const answers: ConflictAnswer[] = ['yes', 'skip']
    const report = await run(config, {
      overwrite: 'ask',
      prompt: async () => answers.shift() as ConflictAnswer,
    })
    expect(report.counts.written).toBe(1)
    expect(report.counts.skipped).toBe(1)
  })

  it('"quit" stops and keeps what was written', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-300w.webp'), 'x')
    const report = await run(config, { overwrite: 'ask', prompt: async () => 'quit' })
    expect(report.aborted).toBe(true)
    expect(report.exitCode).toBe(1)
    expect(readFileSync(join(output, 'a-300w.webp'), 'utf8')).toBe('x')
  })

  it('without a terminal the default is to skip and to fail the exit code', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-300w.webp'), 'x')
    const report = await run(config)
    expect(report.counts.skipped).toBe(1)
    expect(report.counts.written).toBe(1)
    expect(report.exitCode).toBe(1)
  })

  it('--skip-existing skips without failing, --overwrite replaces, --no-overwrite fails', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-300w.webp'), 'x')
    const skipped = await run(config, { overwrite: 'skip' })
    expect(skipped.exitCode).toBe(0)
    expect(skipped.counts.skipped).toBe(1)
    const replaced = await run(config, { overwrite: 'overwrite' })
    expect(replaced.counts.written).toBe(1)
    expect((await meta(join(output, 'a-300w.webp'))).format).toBe('webp')
    writeFileSync(join(output, 'a-300w.webp'), 'x')
    const failed = await run(config, { overwrite: 'error' })
    expect(failed.counts.conflict).toBe(1)
    expect(failed.exitCode).toBe(1)
  })

  it('--force regenerates everything', async () => {
    await run(config)
    const again = await run(config, { force: true, overwrite: 'overwrite' })
    expect(again.counts.written).toBe(2)
  })

  it('a changed recipe invalidates the cache for that output', async () => {
    await run(config)
    const changed = await run(
      { outputs: [{ widths: [300], formats: { webp: { quality: 20 } } }] },
      { overwrite: 'overwrite' },
    )
    expect(changed.counts.written).toBe(2)
  })

  it('--no-cache treats every existing file as a conflict', async () => {
    await run(config)
    const again = await run(config, { cache: false, overwrite: 'skip' })
    expect(again.counts.skipped).toBe(2)
  })

  it('a dry run writes nothing, not even the cache', async () => {
    const report = await run(config, { dryRun: true })
    expect(report.counts['would-write']).toBe(2)
    expect(existsSync(output)).toBe(false)
    const text = renderImageBatchReport(report, { plain: true })
    expect(text).toContain('would be written')
  })

  it('a dry run flags what it would overwrite and never asks', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-300w.webp'), 'x')
    const report = await run(config, {
      dryRun: true,
      overwrite: 'ask',
      prompt: async () => {
        throw new Error('must not ask')
      },
    })
    expect(report.counts['would-overwrite']).toBe(1)
    expect(readFileSync(join(output, 'a-300w.webp'), 'utf8')).toBe('x')
  })

  it('treats an unchanged mtime-only touch as unchanged content', async () => {
    await run(config)
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(input, 'a.png'), later, later)
    const again = await run(config)
    expect(again.counts['up-to-date']).toBe(2)
  })
})

describe('inputs', () => {
  it('walks only the first level without --recursive', async () => {
    const report = await run(
      { outputs: [{ widths: [50], formats: ['png'] }] },
      { recursive: false },
    )
    expect(report.sources.map((s) => s.file)).toEqual(['a.png'])
  })

  it('takes single files, keeping their folder as the root', async () => {
    const report = await run(
      { outputs: [{ widths: [50], formats: ['png'] }] },
      { paths: [join(input, 'sub', 'b.png')] },
    )
    expect(report.results[0]?.output).toBe('b-50w.png')
  })

  it('expands globs and honors include and exclude', async () => {
    const globbed = await run(
      { outputs: [{ widths: [50], formats: ['png'] }] },
      { paths: [join(input, '**', '*.png').replace(/\\/g, '/')] },
    )
    expect(globbed.sources).toHaveLength(2)
    const included = await run(
      { outputs: [{ widths: [50], formats: ['png'] }] },
      { include: ['sub/**'] },
    )
    expect(included.sources.map((s) => s.file)).toEqual(['sub/b.png'])
    const excluded = await run(
      { outputs: [{ widths: [50], formats: ['png'] }] },
      { exclude: ['sub/**'] },
    )
    expect(excluded.sources.map((s) => s.file)).toEqual(['a.png'])
  })

  it('never re-reads its own output folder when it sits inside the input', async () => {
    const nested = join(input, 'resized')
    await run({ outputs: [{ widths: [50], formats: ['png'] }] }, { out: nested })
    const again = await run(
      { outputs: [{ widths: [40], formats: ['png'], name: 'x/{name}.{format}' }] },
      { out: nested },
    )
    expect(again.sources.map((s) => s.file).every((f) => !f.startsWith('resized/'))).toBe(true)
  })

  it('reports no images found without failing', async () => {
    const empty = join(root, 'empty')
    mkdirSync(empty)
    const report = await run({ outputs: [{}] }, { paths: [empty] })
    expect(report.sources).toEqual([])
    expect(report.exitCode).toBe(0)
    expect(renderImageBatchReport(report, { plain: true })).toContain('No images found')
  })

  it('lists images without processing them', async () => {
    const report = await run({ outputs: [{}] }, { list: true })
    expect(report.listOnly).toBe(true)
    expect(report.sources.map((s) => s.file)).toEqual(['a.png', 'sub/b.png'])
    expect(existsSync(output)).toBe(false)
    expect(renderImageBatchReport(report, { plain: true })).toContain('2 images found')
  })

  it('reports an unreadable image and still processes the rest', async () => {
    writeFileSync(join(input, 'broken.png'), 'definitely not a png')
    const report = await run({ outputs: [{ widths: [50], formats: ['png'] }] })
    expect(report.failures.map((f) => f.file)).toEqual(['broken.png'])
    expect(report.counts.written).toBe(2)
    expect(report.exitCode).toBe(1)
    expect(renderImageBatchReport(report, { plain: true })).toContain('could not be read')
  })

  it('refuses an image above --max-pixels', async () => {
    const report = await run({ outputs: [{ widths: [50], formats: ['png'] }] }, { maxPixels: 100 })
    expect(report.failures).toHaveLength(2)
    expect(report.failures[0]?.message).toMatch(/--max-pixels/)
  })
})

describe('placeholders and the emitted manifest', () => {
  it('writes sources, outputs and placeholders for every produced file', async () => {
    const emit = join(root, 'out', 'images.json')
    const report = await run(
      {
        outputs: [{ widths: [200, 400], formats: ['webp'] }],
        placeholders: { hazehash: { budget: 20 }, color: true },
      },
      { emit, keyPrefix: '/img/' },
    )
    expect(report.emitPath).toBe(emit)
    const manifest = JSON.parse(readFileSync(emit, 'utf8'))
    expect(manifest.version).toBe(1)
    expect(manifest.sources['a.png']).toMatchObject({ width: 1200, height: 800, format: 'png' })
    expect(manifest.sources['a.png'].hazehash).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(manifest.sources['a.png'].color).toMatch(/^#[0-9a-f]{6}$/)
    expect(manifest.sources['a.png'].outputs.map((o: { path: string }) => o.path)).toEqual([
      'a-200w.webp',
      'a-400w.webp',
    ])
    expect(manifest.placeholders['/img/a-200w.webp']).toMatchObject({ width: 200, height: 133 })
    expect(manifest.placeholders['/img/sub/b-200w.webp'].hazehash).toBeTruthy()
  })

  it('takes the hazehash size from the budget', async () => {
    const emit = join(root, 'e.json')
    const hash = async (budget: number) => {
      await run(
        { outputs: [{}] },
        {
          emit,
          placeholders: { types: ['hazehash'], budget },
          force: true,
          overwrite: 'overwrite',
        },
      )
      return JSON.parse(readFileSync(emit, 'utf8')).sources['a.png'].hazehash as string
    }
    expect((await hash(10)).length).toBeLessThan((await hash(40)).length)
  })

  it('does not compute hashes when no manifest is wanted', async () => {
    const report = await run({ outputs: [{}], placeholders: { hazehash: true } })
    expect(report.emitPath).toBeUndefined()
  })

  it('lists up-to-date outputs in the manifest too', async () => {
    const emit = join(root, 'e.json')
    await run({ outputs: [{ widths: [100], formats: ['webp'] }] })
    await run({ outputs: [{ widths: [100], formats: ['webp'] }] }, { emit })
    expect(JSON.parse(readFileSync(emit, 'utf8')).sources['a.png'].outputs).toHaveLength(1)
  })

  it('writes no manifest in a dry run', async () => {
    const emit = join(root, 'e.json')
    await run({ outputs: [{}] }, { emit, dryRun: true })
    expect(existsSync(emit)).toBe(false)
  })
})

describe('report rendering', () => {
  it('summarizes a clean run', async () => {
    const report = await run({ outputs: [{ widths: [100], formats: ['webp'] }] })
    const text = renderImageBatchReport(report, { plain: true })
    expect(text).toContain('2 images')
    expect(text).toContain('2 written')
    expect(text).toContain('a-100w.webp')
  })

  it('is silent for a clean run with --quiet', async () => {
    const report = await run({ outputs: [{ widths: [100], formats: ['webp'] }] })
    expect(renderImageBatchReport(report, { plain: true, quiet: true })).toBe('')
  })

  it('colors the status when color is on, and not otherwise', async () => {
    const report = await run({ outputs: [{ widths: [100], formats: ['webp'] }] })
    expect(renderImageBatchReport(report, { color: true })).toContain('\x1b[')
    expect(renderImageBatchReport(report, { plain: true })).not.toContain('\x1b[')
  })

  it('explains skipped files and how to proceed', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-100w.webp'), 'x')
    const report = await run({ outputs: [{ widths: [100], formats: ['webp'] }] })
    const text = renderImageBatchReport(report, { plain: true })
    expect(text).toContain('skipped')
    expect(text).toContain('--overwrite')
  })

  it('shows only problems for big runs unless verbose', async () => {
    const many = Array.from({ length: 45 }, (_, i) => i + 10)
    const report = await run(
      { outputs: [{ widths: many, formats: ['png'] }] },
      { paths: [join(input, 'a.png')] },
    )
    expect(renderImageBatchReport(report, { plain: true })).toContain('not listed')
    expect(renderImageBatchReport(report, { plain: true, verbose: true })).not.toContain(
      'more not shown',
    )
  })
})
