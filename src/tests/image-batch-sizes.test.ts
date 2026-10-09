import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sharp, SharpOptions } from 'sharp'
import { parseByteSize, parseConfig, resolveRecipe } from '../commands/image-batch/config.js'
import {
  boxForLongEdge,
  boxForMegapixels,
  boxForPercent,
  boxForShortEdge,
  matchBoxOrientation,
} from '../commands/image-batch/geometry.js'
import type { SharpFn } from '../commands/image-batch/plan.js'
import {
  completeSharpen,
  parseSharpenFields,
  sharpenParams,
} from '../commands/image-batch/sharpen.js'
import {
  BUILT_IN_SHARPEN_PRESETS,
  attachSharpenPresets,
} from '../commands/image-batch/sharpen-presets.js'
import { runImageBatch, type ImageBatchOptions } from '../commands/image-batch/run.js'

const sharp = createRequire(import.meta.url)('sharp') as SharpFn &
  ((input: unknown, options?: SharpOptions) => Sharp)

let root: string
let input: string
let output: string

async function noisy(
  path: string,
  width: number,
  height: number,
  format: 'png' | 'jpg' = 'png',
  quality = 92,
) {
  const data = Buffer.alloc(width * height * 3)
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 3) * 17) % 256
  mkdirSync(join(path, '..'), { recursive: true })
  const image = sharp(data, { raw: { width, height, channels: 3 } })
  await (format === 'png' ? image.png({ compressionLevel: 1 }) : image.jpeg({ quality })).toFile(
    path,
  )
}

const meta = async (path: string) => sharp(readFileSync(path)).metadata()

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
  root = mkdtempSync(join(tmpdir(), 'ib-sizes-'))
  input = join(root, 'in')
  output = join(root, 'out')
  await noisy(join(input, 'land.png'), 600, 400)
  await noisy(join(input, 'port.png'), 400, 600)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const dims = (report: Awaited<ReturnType<typeof run>>) =>
  Object.fromEntries(report.results.map((r) => [r.output, `${r.width}x${r.height}`]))

describe('size methods: the boxes', () => {
  const landscape = { width: 600, height: 400 }
  const portrait = { width: 400, height: 600 }

  it('long and short edge pick the side by orientation', () => {
    expect(boxForLongEdge(landscape, 300)).toEqual({ width: 300 })
    expect(boxForLongEdge(portrait, 300)).toEqual({ height: 300 })
    expect(boxForShortEdge(landscape, 200)).toEqual({ height: 200 })
    expect(boxForShortEdge(portrait, 200)).toEqual({ width: 200 })
    expect(boxForLongEdge({ width: 500, height: 500 }, 100)).toEqual({ width: 100 })
    expect(boxForShortEdge({ width: 500, height: 500 }, 100)).toEqual({ width: 100 })
  })

  it('megapixels and percent turn into a width that keeps the proportions', () => {
    expect(boxForPercent(landscape, 50)).toEqual({ width: 300 })
    expect(boxForPercent({ width: 3, height: 3 }, 1)).toEqual({ width: 1 })
    const box = boxForMegapixels(landscape, 0.06)
    expect(
      Math.abs((box.width as number) * ((box.width as number) * (2 / 3)) - 60000),
    ).toBeLessThan(800)
  })

  it('matchBoxOrientation turns the box only when the orientation differs', () => {
    expect(matchBoxOrientation({ width: 300, height: 200 }, portrait)).toEqual({
      width: 200,
      height: 300,
    })
    expect(matchBoxOrientation({ width: 300, height: 200 }, landscape)).toEqual({
      width: 300,
      height: 200,
    })
    expect(matchBoxOrientation({ width: 200, height: 300 }, landscape)).toEqual({
      width: 300,
      height: 200,
    })
    expect(matchBoxOrientation({ width: 200, height: 200 }, portrait)).toEqual({
      width: 200,
      height: 200,
    })
    expect(matchBoxOrientation({ width: 300, height: 200 }, { width: 500, height: 500 })).toEqual({
      width: 300,
      height: 200,
    })
  })
})

describe('size methods: results', () => {
  it('long edge sizes both orientations by their long side', async () => {
    const report = await run({ outputs: [{ longEdge: [300], formats: ['webp'] }] })
    expect(dims(report)).toEqual({ 'land-300l.webp': '300x200', 'port-300l.webp': '200x300' })
    expect((await meta(join(output, 'port-300l.webp'))).height).toBe(300)
  })

  it('short edge sizes both orientations by their short side', async () => {
    const report = await run({ outputs: [{ shortEdge: [200], formats: ['webp'] }] })
    expect(dims(report)).toEqual({ 'land-200s.webp': '300x200', 'port-200s.webp': '200x300' })
  })

  it('megapixels sizes by area', async () => {
    const report = await run({ outputs: [{ megapixels: [0.06], formats: ['webp'] }] })
    for (const result of report.results) {
      expect(Math.abs(result.width * result.height - 60000)).toBeLessThan(900)
      expect(result.output).toContain('0.06mp')
    }
  })

  it('percent sizes relative to the source and is named by the percentage', async () => {
    const report = await run({ outputs: [{ percent: [50, 25], formats: ['webp'] }] })
    expect(dims(report)).toEqual({
      'land-50pct.webp': '300x200',
      'port-50pct.webp': '200x300',
      'land-25pct.webp': '150x100',
      'port-25pct.webp': '100x150',
    })
  })

  it('scale multiplies the size of every method', async () => {
    const report = await run({
      outputs: [
        {
          longEdge: [150],
          percent: [10],
          scale: [1, 2],
          formats: ['webp'],
          name: '{name}-{long}-{percent}pct@{scale}x.{format}',
        },
      ],
    })
    const land = report.results.filter((r) => r.source === 'land.png')
    expect(land.map((r) => `${r.width}x${r.height}`).sort()).toEqual(
      ['150x100', '300x200', '60x40', '120x80'].sort(),
    )
  })

  it('does not enlarge by default, and does when told to', async () => {
    const locked = await run({ outputs: [{ percent: [200], formats: ['webp'] }] })
    expect(dims(locked)['land-200pct.webp']).toBe('600x400')
    const open = await run(
      { outputs: [{ percent: [200], formats: ['webp'], withoutEnlargement: false }] },
      { out: join(root, 'open') },
    )
    expect(dims(open)['land-200pct.webp']).toBe('1200x800')
  })

  it('merges methods that land on the same size', async () => {
    const report = await run({
      outputs: [
        {
          widths: [300],
          longEdge: [300],
          formats: ['webp'],
          name: '{name}-{width}x{height}.{format}',
        },
      ],
    })
    expect(report.deduped).toBe(1)
    expect(Object.keys(dims(report)).sort()).toEqual(
      ['land-300x200.webp', 'port-200x300.webp', 'port-300x450.webp'].sort(),
    )
  })

  it('uses the real sides in {long}, {short}, {mp} and {percent}', async () => {
    const report = await run({
      outputs: [
        {
          widths: [300],
          formats: ['webp'],
          name: '{name}-{long}-{short}-{mp}mp-{percent}pct.{format}',
        },
      ],
    })
    expect(Object.keys(dims(report)).sort()).toEqual([
      'land-300-200-0.06mp-50pct.webp',
      'port-450-300-0.14mp-75pct.webp',
    ])
  })

  it('names every method by default and keeps the width naming for widths', async () => {
    const report = await run({
      outputs: [{ widths: [300], longEdge: [200], shortEdge: [100], formats: ['webp'] }],
    })
    const names = report.results
      .filter((r) => r.source === 'land.png')
      .map((r) => r.output)
      .sort()
    expect(names).toEqual(['land-100s.webp', 'land-200l.webp', 'land-300w.webp'])
  })

  it('works with --replace as a maximum', async () => {
    const report = await run(
      { outputs: [{ longEdge: [300] }] },
      { out: undefined, replace: true, assumeYes: true },
    )
    expect(report.counts.replaced).toBe(2)
    expect((await meta(join(input, 'port.png'))).height).toBe(300)
    expect((await meta(join(input, 'land.png'))).width).toBe(300)
  })

  it('--replace sees a long edge as the same setting on the next run', async () => {
    await run(
      { outputs: [{ longEdge: [300] }] },
      { out: undefined, replace: true, assumeYes: true },
    )
    const again = await run(
      { outputs: [{ longEdge: [300] }] },
      { out: undefined, replace: true, assumeYes: true },
    )
    expect(again.counts['already-processed']).toBe(2)
  })
})

describe('matchOrientation', () => {
  const recipe = { size: [300, 200], fit: 'cover', formats: ['png'] }

  it('turns the box around for the other orientation', async () => {
    const config = {
      outputs: [{ size: '300x200', fit: 'cover', formats: ['png'], matchOrientation: true }],
    }
    const report = await run(config)
    expect(dims(report)).toEqual({ 'land-300x200.png': '300x200', 'port-200x300.png': '200x300' })
    expect(recipe).toBeDefined()
  })

  it('keeps the box as it is without it', async () => {
    const report = await run({ outputs: [{ size: '300x200', fit: 'cover', formats: ['png'] }] })
    expect(dims(report)).toEqual({ 'land-300x200.png': '300x200', 'port-300x200.png': '300x200' })
  })
})

describe('maxBytes', () => {
  beforeEach(async () => {
    await noisy(join(input, 'big.jpg'), 800, 600, 'jpg', 95)
  })
  const only = () => ({ paths: [join(input, 'big.jpg')] })

  it('keeps a jpg under the limit by lowering the quality as little as needed', async () => {
    const free = await run(
      { outputs: [{ formats: ['jpg'], name: 'free/{name}.{format}' }] },
      only(),
    )
    const limit = Math.round((free.results[0]?.bytes ?? 0) * 0.5)
    const report = await run({ outputs: [{ formats: ['jpg'], maxBytes: limit }] }, only())
    const size = statSync(join(output, 'big.jpg')).size
    expect(report.counts.error).toBe(0)
    expect(size).toBeLessThanOrEqual(limit)
    expect(size).toBeGreaterThan(limit * 0.6)
  })

  it('does not touch a file that already fits', async () => {
    const free = await run(
      { outputs: [{ formats: ['jpg'], name: 'free/{name}.{format}' }] },
      only(),
    )
    const report = await run(
      { outputs: [{ formats: ['jpg'], maxBytes: (free.results[0]?.bytes ?? 0) + 5000 }] },
      only(),
    )
    expect(statSync(join(output, 'big.jpg')).size).toBe(free.results[0]?.bytes)
    expect(report.counts.written).toBe(1)
  })

  it('works for webp and avif too', async () => {
    const report = await run(
      { outputs: [{ formats: ['webp', 'avif'], maxBytes: '100KB' }] },
      only(),
    )
    expect(report.counts.error).toBe(0)
    expect(statSync(join(output, 'big.webp')).size).toBeLessThanOrEqual(100 * 1024)
    expect(statSync(join(output, 'big.avif')).size).toBeLessThanOrEqual(100 * 1024)
  })

  it('reports a limit that cannot be reached and writes nothing for that file', async () => {
    const report = await run({ outputs: [{ formats: ['jpg'], maxBytes: '1KB' }] }, only())
    expect(report.counts.error).toBe(1)
    expect(report.results[0]?.message).toMatch(/could not get under 1\.00 KB.*smallest result/)
    expect(report.exitCode).toBe(1)
    expect(() => statSync(join(output, 'big.jpg'))).toThrow()
  })

  it('needs a format with a quality setting', async () => {
    await expect(
      run({ outputs: [{ formats: ['png'], maxBytes: '50KB' }] }, only()),
    ).rejects.toThrow(/needs a format with a quality setting/)
    await expect(
      run({ outputs: [{ formats: ['gif'], maxBytes: '50KB' }] }, only()),
    ).rejects.toThrow(/needs a format with a quality setting/)
  })

  it('accepts a png with a palette', async () => {
    const report = await run(
      { outputs: [{ formats: { png: { palette: true } }, maxBytes: '200KB' }] },
      only(),
    )
    expect(report.counts.error).toBe(0)
  })

  it('combines with --replace', async () => {
    const before = statSync(join(input, 'big.jpg')).size
    const report = await run(
      { outputs: [{ maxBytes: Math.round(before / 2) }] },
      { ...only(), out: undefined, replace: true, assumeYes: true },
    )
    expect(report.counts.replaced).toBe(1)
    expect(statSync(join(input, 'big.jpg')).size).toBeLessThanOrEqual(Math.round(before / 2))
  })

  it('counts as a different setting', async () => {
    const first = await run({ outputs: [{ formats: ['jpg'], maxBytes: '60KB' }] }, only())
    const second = await run({ outputs: [{ formats: ['jpg'], maxBytes: '60KB' }] }, only())
    expect(second.counts['up-to-date']).toBe(1)
    const third = await run(
      { outputs: [{ formats: ['jpg'], maxBytes: '50KB' }] },
      { ...only(), overwrite: 'overwrite' },
    )
    expect(third.counts.written).toBe(1)
    expect(first.counts.written).toBe(1)
  })
})

describe('config validation of the new fields', () => {
  it('parses byte sizes', () => {
    expect(parseByteSize('200KB', 'x')).toBe(200 * 1024)
    expect(parseByteSize('1.5MB', 'x')).toBe(Math.round(1.5 * 1024 * 1024))
    expect(parseByteSize('2 m', 'x')).toBe(2 * 1024 * 1024)
    expect(parseByteSize(4096, 'x')).toBe(4096)
    expect(parseByteSize('5000', 'x')).toBe(5000)
    expect(() => parseByteSize('10', 'x')).toThrow(/at least 1 KB/)
    expect(() => parseByteSize('5 TB', 'x')).toThrow(/at least 1 KB/)
    expect(() => parseByteSize('big', 'x')).toThrow(/at least 1 KB/)
  })

  it('checks ranges and types', () => {
    expect(() => parseConfig({ outputs: [{ longEdge: [0] }] })).toThrow(/whole numbers/)
    expect(() => parseConfig({ outputs: [{ shortEdge: [1.5] }] })).toThrow(/whole numbers/)
    expect(() => parseConfig({ outputs: [{ megapixels: [0] }] })).toThrow(/0\.001 to 1000/)
    expect(() => parseConfig({ outputs: [{ percent: [0] }] })).toThrow(/0\.1 to 1000/)
    expect(() => parseConfig({ outputs: [{ percent: ['half'] }] })).toThrow(/expected numbers/)
    expect(() => parseConfig({ outputs: [{ matchOrientation: 'yes' }] })).toThrow(/true or false/)
    expect(() => parseConfig({ outputs: [{ maxBytes: '1B' }] })).toThrow(/at least 1 KB/)
  })

  it('accepts them and resolves them', () => {
    const config = parseConfig({
      outputs: [
        {
          longEdge: 2000,
          shortEdge: [1080],
          megapixels: [2, 0.5],
          percent: 50,
          matchOrientation: true,
          maxBytes: '300KB',
        },
      ],
    })
    const resolved = resolveRecipe(config, config.outputs[0] ?? {})
    expect(resolved.longEdge).toEqual([2000])
    expect(resolved.shortEdge).toEqual([1080])
    expect(resolved.megapixels).toEqual([2, 0.5])
    expect(resolved.percent).toEqual([50])
    expect(resolved.matchOrientation).toBe(true)
    expect(resolved.maxBytes).toBe(300 * 1024)
    expect(resolved.explicitTemplate).toBe(false)
  })

  it('names the default after the first method for display', () => {
    const config = parseConfig({
      outputs: [{ longEdge: [1] }, { shortEdge: [1] }, { megapixels: [1] }, { percent: [1] }],
    })
    expect(config.outputs.map((layer) => resolveRecipe(config, layer).template.text)).toEqual([
      '{dir}/{name}-{long}l.{format}',
      '{dir}/{name}-{short}s.{format}',
      '{dir}/{name}-{mp}mp.{format}',
      '{dir}/{name}-{percent}pct.{format}',
    ])
  })
})

describe('sharpening', () => {
  const base = { id: 'a', widths: [300], formats: ['png'] }

  it('rejects the old true/number forms and unknown names', () => {
    expect(() => parseConfig({ outputs: [{ ...base, sharpen: true }] })).toThrow()
    expect(() => parseConfig({ outputs: [{ ...base, sharpen: 0.8 }] })).toThrow()
    expect(() => parseConfig({ outputs: [{ ...base, sharpen: { for: 'paper' } }] })).toThrow(
      /screen, matte, glossy/,
    )
    expect(() => parseConfig({ outputs: [{ ...base, sharpen: { amount: 'max' } }] })).toThrow(
      /low, standard, high/,
    )
  })

  it('fills the missing half with screen and standard, and does nothing when unset', () => {
    const only = (sharpen?: unknown) =>
      resolveRecipe(
        parseConfig({ outputs: [{ ...base, ...(sharpen ? { sharpen } : {}) }] }),
        parseConfig({ outputs: [{ ...base, ...(sharpen ? { sharpen } : {}) }] }).outputs[0]!,
      ).sharpen
    expect(only()).toBeUndefined()
    expect(only({ for: 'glossy' })).toEqual({ for: 'glossy', amount: 'standard' })
    expect(only({ amount: 'high' })).toEqual({ for: 'screen', amount: 'high' })
  })

  it('merges a flag override field by field over the config', async () => {
    const config = parseConfig({ outputs: [{ ...base, sharpen: { for: 'matte' } }] })
    const recipe = resolveRecipe(config, config.outputs[0]!, [{ sharpen: { amount: 'high' } }])
    expect(recipe.sharpen).toEqual({ for: 'matte', amount: 'high' })
  })

  it('changes the pixels, and a stronger setting changes them more', async () => {
    let n = 0
    const make = async (sharpen?: unknown) => {
      const dir = join(root, `o-${n++}`)
      const report = await run(
        { outputs: [{ ...base, ...(sharpen ? { sharpen } : {}) }] },
        { out: dir },
      )
      expect(report.counts.error).toBe(0)
      const result = report.results.find((r) => r.source === 'land.png')!
      return sharp(join(dir, result.output)).raw().toBuffer()
    }
    const none = await make()
    const low = await make({ for: 'screen', amount: 'low' })
    const high = await make({ for: 'glossy', amount: 'high' })
    const diff = (a: Buffer, b: Buffer) => {
      let total = 0
      for (let i = 0; i < a.length; i++) total += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
      return total
    }
    expect(diff(none, low)).toBeGreaterThan(0)
    expect(diff(none, high)).toBeGreaterThan(diff(none, low))
  })
})

describe('sharpening fine settings and presets', () => {
  const base = { id: 'a', widths: [300], formats: ['png'] }

  const withPresets = (config: unknown, presets: Record<string, unknown>, extra?: unknown) => {
    mkdirSync(join(root, '.git'), { recursive: true })
    const dir = join(root, '.mediatoolz', 'image-batch', 'sharpen')
    mkdirSync(dir, { recursive: true })
    for (const [name, value] of Object.entries(presets)) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(value))
    }
    return attachSharpenPresets(parseConfig(config), {
      cwd: root,
      globalDir: join(root, 'no-global'),
      extra: [extra as never],
    })
  }

  it('checks every fine setting against its range and names it', () => {
    const bad = (sharpen: unknown) => () => parseConfig({ outputs: [{ ...base, sharpen }] })
    expect(bad({ radius: 0 })).toThrow(/sharpen\.radius: expected a number from 0\.000001 to 10/)
    expect(bad({ radius: 11 })).toThrow(/radius/)
    expect(bad({ flat: -1 })).toThrow(/sharpen\.flat: expected a number from 0 to 1000000/)
    expect(bad({ jagged: 'x' })).toThrow(/sharpen\.jagged/)
    expect(bad({ threshold: 2_000_000 })).toThrow(/sharpen\.threshold/)
    expect(bad({})).toThrow(/at least one of/)
    expect(bad({ strength: 3 })).toThrow(/unknown key "strength"/)
    expect(bad(5)).toThrow(/expected a preset name or an object/)
  })

  it('sends the fine settings to sharp and keeps the table value for the rest', () => {
    expect(sharpenParams(completeSharpen({ for: 'screen' }))).toEqual({ sigma: 0.6, m1: 1, m2: 3 })
    expect(sharpenParams(completeSharpen({ for: 'glossy', amount: 'high' }))).toEqual({
      sigma: 1.4,
      m1: 1.8,
      m2: 5,
    })
    expect(
      sharpenParams(completeSharpen({ radius: 2.5, flat: 0.2, jagged: 7, threshold: 4 })),
    ).toEqual({ sigma: 2.5, m1: 0.2, m2: 7, x1: 4 })
  })

  it('lets a field override the table value, field by field across layers', () => {
    const config = parseConfig({
      defaults: { sharpen: { for: 'matte', radius: 1.5 } },
      outputs: [{ ...base, sharpen: { amount: 'high' } }],
    })
    const recipe = resolveRecipe(config, config.outputs[0]!, [{ sharpen: { jagged: 9 } }])
    expect(recipe.sharpen).toEqual({
      for: 'matte',
      amount: 'high',
      radius: 1.5,
      jagged: 9,
    })
  })

  it('expands a preset, lets the recipe override it, and a new preset starts afresh', () => {
    const config = withPresets(
      {
        defaults: { sharpen: 'base' },
        outputs: [
          { ...base, id: 'plain' },
          { ...base, id: 'tuned', sharpen: { preset: 'base', amount: 'low' } },
          { ...base, id: 'other', sharpen: 'second' },
        ],
      },
      {
        base: { for: 'glossy', amount: 'high', radius: 1.1 },
        second: { for: 'screen' },
      },
    )
    const sharpen = (index: number) => resolveRecipe(config, config.outputs[index]!).sharpen
    expect(sharpen(0)).toEqual({ for: 'glossy', amount: 'high', radius: 1.1 })
    expect(sharpen(1)).toEqual({ for: 'glossy', amount: 'low', radius: 1.1 })
    expect(sharpen(2)).toEqual({ for: 'screen', amount: 'standard' })
  })

  it('takes a preset named by a flag-style override too', () => {
    const config = withPresets(
      { outputs: [base] },
      { crisp: { for: 'matte', flat: 2 } },
      {
        preset: 'crisp',
      },
    )
    expect(
      resolveRecipe(config, config.outputs[0]!, [{ sharpen: { preset: 'crisp' } }]).sharpen,
    ).toEqual({
      for: 'matte',
      amount: 'standard',
      flat: 2,
    })
  })

  it('reports a missing preset with the names that exist', () => {
    expect(() =>
      withPresets({ outputs: [{ ...base, sharpen: 'crsip' }] }, { crisp: { for: 'screen' } }),
    ).toThrow(/no sharpen preset named "crsip".*Available: crisp/)
  })

  it('offers the built-in presets when a name does not exist', () => {
    expect(() => withPresets({ outputs: [{ ...base, sharpen: 'x' }] }, {})).toThrow(
      /Available: web-light, web-crisp, web-detail, thumbnail, print-matte, print-glossy/,
    )
  })

  it('resolves a built-in preset, and a project file of the same name wins', () => {
    const config = withPresets({ outputs: [{ ...base, sharpen: 'web-detail' }] }, {})
    expect(resolveRecipe(config, config.outputs[0]!).sharpen).toEqual({
      for: 'screen',
      amount: 'high',
      radius: 0.8,
    })
    const own = withPresets(
      { outputs: [{ ...base, sharpen: 'web-detail' }] },
      { 'web-detail': { for: 'glossy' } },
    )
    expect(resolveRecipe(own, own.outputs[0]!).sharpen).toEqual({
      for: 'glossy',
      amount: 'standard',
    })
  })

  it('keeps every built-in preset valid', () => {
    for (const [name, preset] of Object.entries(BUILT_IN_SHARPEN_PRESETS)) {
      expect(() => parseSharpenFields({ ...preset.fields }, name, false)).not.toThrow()
      expect(preset.description).toBeTruthy()
    }
  })

  it('rejects a broken preset file with its path', () => {
    expect(() =>
      withPresets({ outputs: [{ ...base, sharpen: 'bad' }] }, { bad: { radius: 99 } }),
    ).toThrow(/bad\.json\.radius: expected a number from 0\.000001 to 10/)
    expect(() =>
      withPresets({ outputs: [{ ...base, sharpen: 'nested' }] }, { nested: { preset: 'other' } }),
    ).toThrow(/unknown key "preset"/)
  })

  it('sharpens a stronger fine setting more than a weaker one', async () => {
    const make = async (sharpen: unknown, n: number) => {
      const dir = join(root, `fine-${n}`)
      const report = await run(
        { outputs: [{ ...base, ...(sharpen ? { sharpen } : {}) }] },
        { out: dir },
      )
      expect(report.counts.error).toBe(0)
      const result = report.results.find((r) => r.source === 'land.png')!
      return sharp(join(dir, result.output)).raw().toBuffer()
    }
    const diff = (a: Buffer, b: Buffer) => {
      let total = 0
      for (let i = 0; i < a.length; i++) total += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
      return total
    }
    const weak = await make({ radius: 0.5, flat: 0.2, jagged: 0.5 }, 1)
    const strong = await make({ radius: 2, flat: 5, jagged: 8 }, 2)
    const none = await make(undefined, 3)
    expect(diff(none, strong)).toBeGreaterThan(diff(none, weak))
  })
})
