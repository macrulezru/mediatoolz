import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_DEFAULTS,
  normalizeFormat,
  parseCodecArgs,
  parseQualityArg,
  resolveCodecOptions,
  toSharpOptions,
  validateCodecMap,
  validateCodecOptions,
} from '../commands/image-batch/codecs.js'
import {
  discoverConfigs,
  loadConfig,
  parseConfig,
  resolveConfigRef,
  resolveRecipe,
} from '../commands/image-batch/config.js'
import { ImageBatchUsageError } from '../commands/image-batch/errors.js'
import { computeGeometry, orientedSize, parseSize } from '../commands/image-batch/geometry.js'
import {
  defaultTemplate,
  expandTemplate,
  normalizeRelativePath,
  parseTemplate,
  type TemplateValues,
} from '../commands/image-batch/template.js'
import { closest, didYouMean } from '../utils/closest.js'
import { globToRegExp, hasGlobChars, literalPrefix, matchGlob } from '../utils/glob.js'

describe('codecs', () => {
  it('normalizes format names and aliases', () => {
    expect(normalizeFormat('JPEG')).toBe('jpg')
    expect(normalizeFormat('tif')).toBe('tiff')
    expect(normalizeFormat('original')).toBe('original')
    expect(() => normalizeFormat('bmp')).toThrow(/unknown format "bmp"/)
  })

  it('suggests the closest option name', () => {
    expect(() => validateCodecOptions('jpg', { mozjepg: true }, 'x')).toThrow(
      /Did you mean "mozjpeg"/,
    )
  })

  it('says where an option really lives when it is used on the wrong format', () => {
    expect(() => validateCodecOptions('jpg', { lossless: true }, 'x')).toThrow(
      /not an option of jpg.*webp, avif/,
    )
  })

  it('checks ranges and types', () => {
    expect(() => validateCodecOptions('webp', { quality: 101 }, 'x')).toThrow(/1–100/)
    expect(() => validateCodecOptions('webp', { effort: 7 }, 'x')).toThrow(/0–6/)
    expect(() => validateCodecOptions('png', { colors: 1 }, 'x')).toThrow(/2–256/)
    expect(() => validateCodecOptions('avif', { bitdepth: 9 }, 'x')).toThrow(/8, 10, 12/)
    expect(() => validateCodecOptions('jpg', { mozjpeg: 'maybe' }, 'x')).toThrow(/true or false/)
  })

  it('coerces CLI strings', () => {
    expect(validateCodecOptions('jpg', { quality: '85', mozjpeg: 'true' }, 'x')).toEqual({
      quality: 85,
      mozjpeg: true,
    })
    expect(validateCodecOptions('webp', { quality: 'high' }, 'x')).toEqual({ quality: 'high' })
  })

  it('parses --codec arguments', () => {
    expect(parseCodecArgs(['jpg.mozjpeg=false', 'png.colors=64', 'png.palette=true'])).toEqual({
      jpg: { mozjpeg: false },
      png: { colors: 64, palette: true },
    })
    expect(() => parseCodecArgs(['mozjpeg=true'])).toThrow(/format.option=value/)
  })

  it('parses --quality in its three forms', () => {
    expect(parseQualityArg('82')).toBe(82)
    expect(parseQualityArg('high')).toBe('high')
    expect(parseQualityArg('jpg=82,webp=high')).toEqual({ jpg: 82, webp: 'high' })
    expect(() => parseQualityArg('loud')).toThrow()
    expect(() => parseQualityArg('gif=50')).toThrow(/no quality/)
  })

  it('validates a codec map', () => {
    expect(validateCodecMap({ jpeg: { quality: 70 } }, 'x')).toEqual({ jpg: { quality: 70 } })
    expect(() => validateCodecMap({ original: {} }, 'x')).toThrow(/original/)
  })

  it('resolves layers: defaults, then quality shortcut, then explicit options', () => {
    expect(resolveCodecOptions('jpg', [])).toEqual(BUILTIN_DEFAULTS.jpg)
    expect(
      resolveCodecOptions('jpg', [
        { quality: 90, codecs: { jpg: { mozjpeg: false } } },
        { quality: 70 },
      ]),
    ).toEqual({ quality: 70, mozjpeg: false, progressive: true })
    expect(
      resolveCodecOptions('webp', [{ quality: 90, codecs: { webp: { quality: 60 } } }]).quality,
    ).toBe(60)
  })

  it('turns quality levels into per-format numbers', () => {
    expect(resolveCodecOptions('jpg', [{ quality: 'high' }]).quality).toBe(85)
    expect(resolveCodecOptions('avif', [{ quality: 'high' }]).quality).toBe(60)
    expect(resolveCodecOptions('webp', [{ quality: { webp: 'best', jpg: 50 } }]).quality).toBe(90)
  })

  it('applies a per-format quality only to that format', () => {
    expect(resolveCodecOptions('jpg', [{ quality: { webp: 10 } }]).quality).toBe(82)
  })

  it('never quantizes a png on its own: quality counts only with palette', () => {
    expect(resolveCodecOptions('png', [{ quality: 50 }])).toEqual({ compressionLevel: 9 })
    expect(
      resolveCodecOptions('png', [{ quality: 50, codecs: { png: { palette: true } } }]),
    ).toMatchObject({
      palette: true,
      quality: 50,
    })
  })

  it('ignores a global quality for formats that have none', () => {
    expect(resolveCodecOptions('gif', [{ quality: 50 }])).toEqual({})
  })

  it('renames colors to the sharp spelling', () => {
    expect(toSharpOptions({ colors: 64, effort: 3 })).toEqual({ colours: 64, effort: 3 })
  })
})

describe('name templates', () => {
  const values: TemplateValues = {
    name: 'hero',
    ext: 'png',
    format: 'webp',
    dir: 'photos/2024',
    width: 800,
    height: 450,
    size: '800x450',
    scale: '2',
    index: 7,
    hash: 'abcdef0123456789',
    date: '2026-10-07',
    orig: 'hero.png',
  }
  const expand = (text: string) => expandTemplate(parseTemplate(text, 't'), values, 't')

  it('expands every variable', () => {
    expect(expand('{dir}/{name}-{width}w.{format}')).toBe('photos/2024/hero-800w.webp')
    expect(expand('{name}@{scale}x.{format}')).toBe('hero@2x.webp')
    expect(expand('{size}/{orig}')).toBe('800x450/hero.png')
    expect(expand('{date}_{ext}_{height}')).toBe('2026-10-07_png_450')
  })

  it('pads the index and shortens the hash', () => {
    expect(expand('{index}')).toBe('7')
    expect(expand('{index:3}-{name}')).toBe('007-hero')
    expect(expand('{name}.{hash}')).toBe('hero.abcdef01')
    expect(expand('{name}.{hash:4}')).toBe('hero.abcd')
  })

  it('drops an empty {dir} instead of leaving a leading slash', () => {
    const rootValues = { ...values, dir: '' }
    expect(expandTemplate(parseTemplate('{dir}/{name}.{format}', 't'), rootValues, 't')).toBe(
      'hero.webp',
    )
  })

  it('rejects unknown variables with a suggestion', () => {
    expect(() => parseTemplate('{nmae}.png', 't')).toThrow(
      /unknown variable \{nmae\}.*Did you mean "name"/,
    )
  })

  it('rejects parameters where none are allowed', () => {
    expect(() => parseTemplate('{name:3}', 't')).toThrow(/takes no parameter/)
    expect(() => parseTemplate('{hash:99}', 't')).toThrow(/1–40/)
  })

  it('rejects absolute paths, parent segments and stray braces', () => {
    expect(() => parseTemplate('/etc/{name}', 't')).toThrow(/absolute/)
    expect(() => parseTemplate('C:\\x\\{name}', 't')).toThrow(/absolute/)
    expect(() => parseTemplate('../{name}', 't')).toThrow(/\.\./)
    expect(() => parseTemplate('{name', 't')).toThrow(/unbalanced/)
    expect(() => parseTemplate('', 't')).toThrow(/empty/)
  })

  it('refuses names that would escape through the source directory', () => {
    expect(() =>
      expandTemplate(parseTemplate('{dir}/{name}', 't'), { ...values, dir: '../out' }, 't'),
    ).toThrow(/escapes/)
  })

  it('refuses characters that are not valid in file names', () => {
    expect(() => normalizeRelativePath('a/b?c.png', 't')).toThrow(/not allowed/)
  })

  it('picks a sensible default template', () => {
    expect(defaultTemplate({ widths: true })).toBe('{dir}/{name}-{width}w.{format}')
    expect(defaultTemplate({ heights: true })).toBe('{dir}/{name}-{height}h.{format}')
    expect(defaultTemplate({ size: true })).toBe('{dir}/{name}-{size}.{format}')
    expect(defaultTemplate({ scale: true })).toBe('{dir}/{name}@{scale}x.{format}')
    expect(defaultTemplate({})).toBe('{dir}/{name}.{format}')
  })
})

describe('geometry', () => {
  const source = { width: 1000, height: 500 }

  it('scales by width and by height', () => {
    expect(computeGeometry(source, { width: 400 }, 'inside', true)).toMatchObject({
      width: 400,
      height: 200,
    })
    expect(computeGeometry(source, { height: 100 }, 'inside', true)).toMatchObject({
      width: 200,
      height: 100,
    })
  })

  it('does not enlarge unless asked to', () => {
    expect(computeGeometry(source, { width: 2000 }, 'inside', true)).toEqual({
      width: 1000,
      height: 500,
      resize: null,
    })
    expect(computeGeometry(source, { width: 2000 }, 'inside', false)).toMatchObject({
      width: 2000,
      height: 1000,
    })
  })

  it('fits inside and outside a box', () => {
    expect(computeGeometry(source, { width: 200, height: 200 }, 'inside', true)).toMatchObject({
      width: 200,
      height: 100,
    })
    expect(computeGeometry(source, { width: 200, height: 200 }, 'outside', true)).toMatchObject({
      width: 400,
      height: 200,
    })
  })

  it('fills the exact box for cover, contain and fill', () => {
    for (const fit of ['cover', 'contain', 'fill'] as const) {
      expect(computeGeometry(source, { width: 300, height: 300 }, fit, true)).toMatchObject({
        width: 300,
        height: 300,
        resize: { width: 300, height: 300, fit },
      })
    }
  })

  it('shrinks an oversized cover box instead of enlarging the source', () => {
    const result = computeGeometry(source, { width: 2000, height: 2000 }, 'cover', true)
    expect(result.width).toBe(500)
    expect(result.height).toBe(500)
  })

  it('keeps at least one pixel', () => {
    expect(computeGeometry({ width: 1000, height: 1 }, { width: 10 }, 'inside', true).height).toBe(
      1,
    )
  })

  it('parses sizes', () => {
    expect(parseSize('800x600', 's')).toEqual({ width: 800, height: 600 })
    expect(parseSize('800 × 600', 's')).toEqual({ width: 800, height: 600 })
    expect(() => parseSize('800', 's')).toThrow(/800x600/)
    expect(() => parseSize('0x5', 's')).toThrow()
  })

  it('swaps the sides for EXIF orientation and quarter turns', () => {
    expect(orientedSize({ width: 400, height: 300 }, 6, true, undefined)).toEqual({
      width: 300,
      height: 400,
    })
    expect(orientedSize({ width: 400, height: 300 }, 6, false, undefined)).toEqual({
      width: 400,
      height: 300,
    })
    expect(orientedSize({ width: 400, height: 300 }, 1, true, 90)).toEqual({
      width: 300,
      height: 400,
    })
    expect(orientedSize({ width: 400, height: 300 }, 6, true, 90)).toEqual({
      width: 400,
      height: 300,
    })
  })
})

describe('glob', () => {
  it('matches the usual wildcards', () => {
    expect(matchGlob('hero/**', 'hero/a/b.png')).toBe(true)
    expect(matchGlob('hero/**', 'other/hero/a.png')).toBe(false)
    expect(matchGlob('**/*.png', 'a/b/c.png')).toBe(true)
    expect(matchGlob('**/*.png', 'c.png')).toBe(true)
    expect(matchGlob('*.png', 'deep/er/c.png')).toBe(true)
    expect(matchGlob('photos/*.jpg', 'photos/a.jpg')).toBe(true)
    expect(matchGlob('photos/*.jpg', 'photos/sub/a.jpg')).toBe(false)
    expect(matchGlob('a?.png', 'ab.png')).toBe(true)
    expect(matchGlob('a?.png', 'abc.png')).toBe(false)
  })

  it('supports braces and classes, case-insensitively', () => {
    expect(matchGlob('**/*.{png,jpg}', 'x/A.JPG')).toBe(true)
    expect(matchGlob('**/*.{png,jpg}', 'x/a.gif')).toBe(false)
    expect(matchGlob('img[0-9].png', 'img5.png')).toBe(true)
    expect(matchGlob('img[!0-9].png', 'img5.png')).toBe(false)
  })

  it('escapes regex characters in literals', () => {
    expect(matchGlob('a.b+c.png', 'a.b+c.png')).toBe(true)
    expect(matchGlob('a.b+c.png', 'aXb+c.png')).toBe(false)
    expect(globToRegExp('x(1).png').test('x(1).png')).toBe(true)
  })

  it('finds the literal prefix', () => {
    expect(hasGlobChars('a/*.png')).toBe(true)
    expect(hasGlobChars('a/b.png')).toBe(false)
    expect(literalPrefix('photos/2024/*.jpg')).toBe('photos/2024')
    expect(literalPrefix('*.jpg')).toBe('')
  })

  it('suggests close words', () => {
    expect(closest('widht', ['width', 'height'])).toBe('width')
    expect(closest('zzzzzz', ['width', 'height'])).toBeUndefined()
    expect(didYouMean('widht', ['width'])).toContain('width')
  })
})

describe('config', () => {
  it('accepts a full config and normalizes scalars to lists', () => {
    const config = parseConfig({
      name: 'web',
      defaults: { fit: 'cover', withoutEnlargement: false },
      presets: { web: { widths: 400, formats: 'webp' }, big: { extends: 'web', widths: [1600] } },
      outputs: [
        { id: 'a', preset: 'web' },
        { size: '64x64', formats: { png: { palette: true } } },
      ],
      match: [{ glob: 'hero/**', outputs: [{ widths: [2000] }] }],
      placeholders: { hazehash: { budget: 20 }, color: true },
    })
    expect(config.presets.web?.widths).toEqual([400])
    expect(config.presets.web?.formats).toEqual(['webp'])
    expect(config.outputs[1]?.codecs).toEqual({ png: { palette: true } })
    expect(config.placeholders).toEqual({ types: ['hazehash', 'color'], budget: 20 })
  })

  it('rejects unknown keys with a suggestion', () => {
    expect(() => parseConfig({ outputs: [{ widht: [100] }] })).toThrow(
      /unknown key "widht".*Did you mean "widths"/,
    )
    expect(() => parseConfig({ input: 'src' })).toThrow(/unknown key "input"/)
  })

  it('has no input or output paths: those are run-time arguments', () => {
    expect(() => parseConfig({ output: 'public' })).toThrow(/unknown key "output"/)
    expect(() => parseConfig({ emit: 'x.json' })).toThrow(/unknown key "emit"/)
  })

  it('validates values', () => {
    expect(() => parseConfig({ outputs: [{ widths: [0] }] })).toThrow(/whole numbers/)
    expect(() => parseConfig({ outputs: [{ fit: 'stretch' }] })).toThrow(/one of cover/)
    expect(() => parseConfig({ outputs: [{ formats: ['bmp'] }] })).toThrow(/unknown format/)
    expect(() => parseConfig({ outputs: [{ rotate: 45 }] })).toThrow(/90, 180 or 270/)
    expect(() => parseConfig({ outputs: [{ name: '{nope}' }] })).toThrow(/unknown variable/)
    expect(() => parseConfig({ placeholders: { hazehash: { budget: 99 } } })).toThrow(/7–48/)
    expect(() => parseConfig({ outputs: [{ formats: { jpg: { lossless: true } } }] })).toThrow(
      /not an option of jpg/,
    )
  })

  it('rejects unknown presets and preset loops', () => {
    expect(() => parseConfig({ outputs: [{ preset: 'ghost' }] })).toThrow(/unknown preset "ghost"/)
    const loop = parseConfig({
      presets: { a: { extends: 'b' }, b: { extends: 'a' } },
      outputs: [{ preset: 'a' }],
    })
    expect(() => resolveRecipe(loop, loop.outputs[0] ?? {})).toThrow(/loop/)
  })

  it('noResize drops every size the config sets and keeps the original name', () => {
    const config = parseConfig({
      defaults: { widths: [100], scale: [1, 2] },
      outputs: [{ longEdge: [800], percent: [50], formats: ['webp'] }],
    })
    const resolved = resolveRecipe(config, config.outputs[0] ?? {}, [{ noResize: true }])
    expect(resolved.widths).toEqual([])
    expect(resolved.longEdge).toEqual([])
    expect(resolved.percent).toEqual([])
    expect(resolved.scales).toEqual([1])
    expect(resolved.template.text).toBe('{dir}/{name}.{format}')
    expect(resolved.formats).toEqual(['webp'])
  })

  it('rejects duplicate recipe ids', () => {
    expect(() => parseConfig({ outputs: [{ id: 'a' }, { id: 'a' }] })).toThrow(/used twice/)
  })

  it('merges defaults, preset chain, recipe and overrides — later wins, lists replace', () => {
    const config = parseConfig({
      defaults: { fit: 'cover', widths: [100], quality: 50 },
      presets: {
        base: { widths: [200], formats: ['webp'] },
        wide: { extends: 'base', widths: [300] },
      },
      outputs: [{ preset: 'wide', fit: 'inside' }],
    })
    const resolved = resolveRecipe(config, config.outputs[0] ?? {}, [{ widths: [999] }])
    expect(resolved.widths).toEqual([999])
    expect(resolved.fit).toBe('inside')
    expect(resolved.formats).toEqual(['webp'])
    expect(resolved.layers.map((layer) => layer.quality)).toEqual([
      50,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('chooses the default name template from the recipe shape', () => {
    const config = parseConfig({
      outputs: [{ widths: [1] }, { heights: [1] }, { size: '1x1' }, { scale: [2] }, {}],
    })
    const names = config.outputs.map((layer) => resolveRecipe(config, layer).template.text)
    expect(names).toEqual([
      '{dir}/{name}-{width}w.{format}',
      '{dir}/{name}-{height}h.{format}',
      '{dir}/{name}-{size}.{format}',
      '{dir}/{name}@{scale}x.{format}',
      '{dir}/{name}.{format}',
    ])
  })
})

describe('config discovery', () => {
  let root: string
  let globalDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ib-config-'))
    globalDir = join(root, 'home', '.mediatoolz', 'image-batch')
    mkdirSync(join(root, 'proj', '.mediatoolz', 'image-batch'), { recursive: true })
    mkdirSync(join(root, 'proj', 'sub', 'deep'), { recursive: true })
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(
      join(root, 'proj', '.mediatoolz', 'image-batch', 'web.json'),
      '{"outputs":[{"widths":[100]}]}',
    )
    writeFileSync(join(root, 'proj', '.mediatoolz', 'image-batch', 'notes.txt'), 'x')
    writeFileSync(join(globalDir, 'web.json'), '{"outputs":[{"widths":[999]}]}')
    writeFileSync(join(globalDir, 'avatars.json'), '{"outputs":[{"size":"64x64"}]}')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds project configs walking up, then global ones, ignoring other files', () => {
    const found = discoverConfigs({ cwd: join(root, 'proj', 'sub', 'deep'), globalDir })
    expect(found.map((c) => `${c.scope}:${c.name}`)).toEqual([
      'project:web',
      'global:avatars',
      'global:web',
    ])
  })

  it('prefers a project config over a global one of the same name', () => {
    const found = discoverConfigs({ cwd: join(root, 'proj'), globalDir })
    expect(resolveConfigRef('web', found, root).scope).toBe('project')
    expect(resolveConfigRef('avatars', found, root).scope).toBe('global')
  })

  it('resolves a path and explains an unknown name', () => {
    const found = discoverConfigs({ cwd: join(root, 'proj'), globalDir })
    expect(resolveConfigRef(join(globalDir, 'web.json'), found, root).path).toBe(
      join(globalDir, 'web.json'),
    )
    expect(() => resolveConfigRef('wbe', found, root)).toThrow(/Did you mean "web"/)
    expect(() => resolveConfigRef('missing.json', found, root)).toThrow(/not found/)
  })

  it('loads json, js and ts configs', async () => {
    const dir = join(root, 'proj', '.mediatoolz', 'image-batch')
    writeFileSync(join(dir, 'fn.mjs'), 'export default () => ({ outputs: [{ widths: [321] }] })')
    writeFileSync(
      join(dir, 'obj.ts'),
      'const c: { outputs: object[] } = { outputs: [{ widths: [654] }] }\nexport default c',
    )
    const found = discoverConfigs({ cwd: join(root, 'proj'), globalDir })
    const load = async (name: string) =>
      (await loadConfig(found.find((c) => c.name === name && c.scope === 'project') as never))
        .config
    expect((await load('web')).outputs[0]?.widths).toEqual([100])
    expect((await load('fn')).outputs[0]?.widths).toEqual([321])
    expect((await load('obj')).outputs[0]?.widths).toEqual([654])
  })

  it('reports invalid JSON with the file path', async () => {
    const dir = join(root, 'proj', '.mediatoolz', 'image-batch')
    writeFileSync(join(dir, 'bad.json'), '{ nope')
    const found = discoverConfigs({ cwd: join(root, 'proj'), globalDir })
    await expect(loadConfig(found.find((c) => c.name === 'bad') as never)).rejects.toThrow(
      ImageBatchUsageError,
    )
  })
})

describe('config discovery boundary', () => {
  it('stops at the repository root instead of reaching unrelated parent folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'ib-boundary-'))
    try {
      const outer = join(root, 'outer', '.mediatoolz', 'image-batch')
      const inner = join(root, 'outer', 'repo', '.mediatoolz', 'image-batch')
      mkdirSync(outer, { recursive: true })
      mkdirSync(inner, { recursive: true })
      mkdirSync(join(root, 'outer', 'repo', '.git'))
      mkdirSync(join(root, 'outer', 'repo', 'src'))
      writeFileSync(join(outer, 'outer.json'), '{}')
      writeFileSync(join(inner, 'inner.json'), '{}')
      const found = discoverConfigs({
        cwd: join(root, 'outer', 'repo', 'src'),
        globalDir: join(root, 'none'),
      })
      expect(found.map((c) => c.name)).toEqual(['inner'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('dots in name templates', () => {
  it('allows dots around variables but still refuses a real parent segment', () => {
    expect(() => parseTemplate('{name}.{hash:6}.{format}', 't')).not.toThrow()
    expect(() => parseTemplate('{name}..{format}', 't')).not.toThrow()
    expect(() => parseTemplate('../{name}.{format}', 't')).toThrow(/\.\./)
  })
})
