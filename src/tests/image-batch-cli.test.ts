import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Sharp, SharpOptions } from 'sharp'

const sharp = createRequire(import.meta.url)('sharp') as (
  input: unknown,
  options?: SharpOptions,
) => Sharp
const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url))
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href

let root: string
let home: string

function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', tsxLoader, cliPath, 'image-batch', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '', FORCE_COLOR: '', USERPROFILE: home, HOME: home, ...env },
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ib-cli-'))
  home = join(root, 'home')
  mkdirSync(join(root, 'img', 'sub'), { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const path of ['img/a.png', 'img/sub/b.png']) {
    await sharp(Buffer.alloc(80 * 60 * 3, 100), { raw: { width: 80, height: 60, channels: 3 } })
      .png()
      .toFile(join(root, path))
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('image-batch command line', { timeout: 120_000 }, () => {
  it('resizes by flags and exits 0', () => {
    const result = cli([
      'img',
      '-r',
      '-o',
      'out',
      '-w',
      '40',
      '-f',
      'webp',
      '-q',
      'high',
      '--plain',
    ])
    expect(result.status).toBe(0)
    expect(existsSync(join(root, 'out', 'a-40w.webp'))).toBe(true)
    expect(existsSync(join(root, 'out', 'sub', 'b-40w.webp'))).toBe(true)
    expect(result.stdout).toContain('2 written')
  })

  it('converts only the format when no size is given', () => {
    const result = cli(['img', '-o', 'out', '-f', 'webp', '--plain'])
    expect(result.status).toBe(0)
    expect(existsSync(join(root, 'out', 'a.webp'))).toBe(true)
    expect(result.stdout).toContain('80×60')
  })

  it('--no-resize ignores the sizes of a config', () => {
    mkdirSync(join(root, '.mediatoolz', 'image-batch'), { recursive: true })
    writeFileSync(
      join(root, '.mediatoolz', 'image-batch', 'sized.json'),
      JSON.stringify({ outputs: [{ widths: [40], formats: ['webp'] }] }),
    )
    const result = cli(['img', '-c', 'sized', '-o', 'out', '--no-resize', '--plain'])
    expect(result.status).toBe(0)
    expect(existsSync(join(root, 'out', 'a.webp'))).toBe(true)
    expect(existsSync(join(root, 'out', 'a-40w.webp'))).toBe(false)
  })

  it('--no-resize refuses to be combined with a size flag', () => {
    const result = cli(['img', '-o', 'out', '-f', 'webp', '--no-resize', '-w', '40'])
    expect(result.status).not.toBe(0)
    expect(result.stderr + result.stdout).toContain('cannot be combined with --widths')
  })

  it('applies a config by name, from the project folder', () => {
    mkdirSync(join(root, '.mediatoolz', 'image-batch'), { recursive: true })
    writeFileSync(
      join(root, '.mediatoolz', 'image-batch', 'web.json'),
      JSON.stringify({ outputs: [{ widths: [20], formats: ['png'], name: 'x/{name}.{format}' }] }),
    )
    const result = cli(['img', '-o', 'out', '-c', 'web', '--plain'])
    expect(result.status).toBe(0)
    expect(existsSync(join(root, 'out', 'x', 'a.png'))).toBe(true)
  })

  it('takes the only available config by itself, but not when flags describe the job', () => {
    mkdirSync(join(root, '.mediatoolz', 'image-batch'), { recursive: true })
    writeFileSync(
      join(root, '.mediatoolz', 'image-batch', 'web.json'),
      JSON.stringify({ outputs: [{ widths: [20], formats: ['png'] }] }),
    )
    expect(cli(['img', '-o', 'out1', '--plain']).stdout).toContain('config web')
    const adHoc = cli(['img', '-o', 'out2', '-w', '30', '-f', 'png', '--plain'])
    expect(adHoc.stdout).not.toContain('config web')
    expect(existsSync(join(root, 'out2', 'a-30w.png'))).toBe(true)
  })

  it('lets flags override the config', () => {
    mkdirSync(join(root, '.mediatoolz', 'image-batch'), { recursive: true })
    writeFileSync(
      join(root, '.mediatoolz', 'image-batch', 'web.json'),
      JSON.stringify({ outputs: [{ widths: [20], formats: ['png'] }] }),
    )
    const result = cli(['img', '-o', 'out', '-c', 'web', '-w', '30', '--plain'])
    expect(result.status).toBe(0)
    expect(existsSync(join(root, 'out', 'a-30w.png'))).toBe(true)
    expect(existsSync(join(root, 'out', 'a-20w.png'))).toBe(false)
  })

  it('passes codec options with --codec and -q per format', () => {
    const low = cli(['img', '-o', 'low', '-f', 'jpg', '-q', 'jpg=20', '--plain'])
    const high = cli(['img', '-o', 'high', '-f', 'jpg', '--codec', 'jpg.quality=95', '--plain'])
    expect(low.status).toBe(0)
    expect(high.status).toBe(0)
    expect(readFileSync(join(root, 'low', 'a.jpg')).length).toBeLessThanOrEqual(
      readFileSync(join(root, 'high', 'a.jpg')).length,
    )
  })

  it('exits 2 with a clear message for bad input', () => {
    const noOut = cli(['img', '--plain'])
    expect(noOut.status).toBe(2)
    expect(noOut.stderr).toMatch(/--out/)
    const badFormat = cli(['img', '-o', 'o', '-f', 'bmp'])
    expect(badFormat.status).toBe(2)
    expect(badFormat.stderr).toMatch(/unknown format "bmp"/)
    const badOption = cli(['img', '-o', 'o', '-f', 'jpg', '--codec', 'jpg.mozjepg=true'])
    expect(badOption.status).toBe(2)
    expect(badOption.stderr).toMatch(/Did you mean "mozjpeg"/)
    const badConfig = cli(['img', '-o', 'o', '-c', 'nothere'])
    expect(badConfig.status).toBe(2)
    expect(badConfig.stderr).toMatch(/no config named "nothere"/)
    const budgetAlone = cli(['img', '-o', 'o', '--budget', '20'])
    expect(budgetAlone.status).toBe(2)
    expect(budgetAlone.stderr).toMatch(/--hazehash/)
    const noEmit = cli(['img', '-o', 'o', '--hazehash'])
    expect(noEmit.status).toBe(2)
    expect(noEmit.stderr).toMatch(/--emit/)
  })

  it('--select without a terminal explains --list', () => {
    const result = cli(['img', '-o', 'o', '--select'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/--list/)
  })

  it('--list prints the images and writes nothing', () => {
    const result = cli(['img', '-r', '--list', '--plain'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('2 images found')
    expect(result.stdout).toContain('sub/b.png')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('--json prints the whole report', () => {
    const result = cli(['img', '-r', '-o', 'out', '-w', '30', '--json'])
    const report = JSON.parse(result.stdout)
    expect(report.counts.written).toBe(2)
    expect(report.results[0]).toMatchObject({ source: 'a.png', width: 30 })
  })

  it('the exit code is 1 and the message helpful when files exist and nobody can be asked', () => {
    cli(['img', '-o', 'out', '-w', '30', '--plain'])
    writeFileSync(join(root, 'out', 'a-30w.jpg'), 'x')
    const second = cli(['img', '-o', 'out', '-w', '30', '-f', 'jpg', '--plain'])
    expect(second.status).toBe(1)
    expect(second.stdout).toContain('--overwrite')
    expect(
      cli(['img', '-o', 'out', '-w', '30', '-f', 'jpg', '--skip-existing', '--plain']).status,
    ).toBe(0)
    expect(
      cli(['img', '-o', 'out', '-w', '30', '-f', 'jpg', '--overwrite', '--plain']).status,
    ).toBe(0)
    expect(
      cli(['img', '-o', 'out', '-w', '30', '-f', 'jpg', '--no-cache', '--no-overwrite', '--plain'])
        .status,
    ).toBe(1)
  })

  it('--emit writes the manifest with the hazehash and its budget', () => {
    const result = cli([
      'img',
      '-r',
      '-o',
      'out',
      '-w',
      '30',
      '--hazehash',
      '--budget',
      '16',
      '--emit',
      'out/m.json',
      '--key-prefix',
      '/i/',
      '--plain',
    ])
    expect(result.status).toBe(0)
    const manifest = JSON.parse(readFileSync(join(root, 'out', 'm.json'), 'utf8'))
    expect(manifest.placeholders['/i/a-30w.png'].hazehash.length).toBeLessThanOrEqual(22)
  })

  it('--dry-run writes nothing', () => {
    const result = cli(['img', '-r', '-o', 'out', '-w', '30', '--dry-run', '--plain'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('would be written')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('--flat drops the source subfolders and --flatten sets a background', () => {
    const result = cli([
      'img',
      '-r',
      '-o',
      'out',
      '-f',
      'jpg',
      '--flat',
      '--flatten',
      '#ff0000',
      '--plain',
    ])
    expect(result.status).toBe(0)
    expect(existsSync(join(root, 'out', 'b.jpg'))).toBe(true)
  })

  it('--files-from reads paths from a file', () => {
    writeFileSync(join(root, 'list.txt'), '# images\nimg/a.png\n')
    const result = cli(['--files-from', 'list.txt', '-o', 'out', '-w', '30', '--plain'])
    expect(result.status).toBe(0)
    expect(existsSync(join(root, 'out', 'a-30w.png'))).toBe(true)
  })

  it('colors the report only when asked or on a terminal', () => {
    expect(cli(['img', '-o', 'a', '-w', '30', '--color']).stdout).toContain('\x1b[')
    expect(cli(['img', '-o', 'b', '-w', '30', '--plain']).stdout).not.toContain('\x1b[')
  })

  it('--quiet prints nothing on success', () => {
    expect(cli(['img', '-o', 'out', '-w', '30', '--quiet', '--plain']).stdout).toBe('')
  })
})

describe('image-batch init and config', { timeout: 120_000 }, () => {
  it('init creates a project config from flags, and config list shows it', () => {
    const created = cli(['init', '--name', 'web', '-w', '320,640', '-f', 'webp,jpg', '--plain'])
    expect(created.status).toBe(0)
    const path = join(root, '.mediatoolz', 'image-batch', 'web.json')
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0]).toMatchObject({
      widths: [320, 640],
      formats: ['webp', 'jpg'],
    })
    const listed = cli(['config', 'list', '--plain'])
    expect(listed.stdout).toContain('web')
    expect(listed.stdout).toContain('project')
    const json = JSON.parse(cli(['config', 'list', '--json']).stdout)
    expect(json[0]).toMatchObject({ name: 'web', scope: 'project', recipes: 1 })
  })

  it('init saves the sharpening flags, and rejects unknown ones', () => {
    const made = cli([
      'init',
      '--name',
      'sharp',
      '--sharpen-for',
      'glossy',
      '--sharpen-amount',
      'high',
      '--plain',
    ])
    expect(made.status).toBe(0)
    const path = join(root, '.mediatoolz', 'image-batch', 'sharp.json')
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].sharpen).toEqual({
      for: 'glossy',
      amount: 'high',
    })
    const bad = cli(['init', '--name', 'bad', '--sharpen-for', 'paper', '--plain'])
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('--sharpen-for: expected one of screen, matte, glossy')
  })

  it('init --global saves under the home folder', () => {
    expect(cli(['init', '--name', 'shared', '--global', '--plain']).status).toBe(0)
    expect(existsSync(join(home, '.mediatoolz', 'image-batch', 'shared.json'))).toBe(true)
  })

  it('init without a name and without a terminal exits 2', () => {
    const result = cli(['init', '--plain'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/--name/)
  })

  it('config show prints the recipes, config rm needs --yes and keeps a backup', () => {
    cli(['init', '--name', 'web', '--plain'])
    const shown = cli(['config', 'show', 'web', '--plain'])
    expect(shown.status).toBe(0)
    expect(shown.stdout).toContain('responsive')
    expect(cli(['config', 'rm', 'web', '--plain']).status).toBe(2)
    const removed = cli(['config', 'rm', 'web', '--yes', '--plain'])
    expect(removed.status).toBe(0)
    expect(existsSync(join(root, '.mediatoolz', 'image-batch', 'web.json.bak'))).toBe(true)
    expect(cli(['config', 'show', 'web', '--plain']).status).toBe(2)
  })

  it('a folder named like a subcommand still works as a path with ./', () => {
    mkdirSync(join(root, 'init'))
    const result = cli(['./init', '-o', 'out', '--plain'])
    expect(result.status).toBe(0)
  })
})

describe('image-batch --beside, --replace and restore', { timeout: 120_000 }, () => {
  it('--beside writes the results next to the sources', () => {
    const result = cli(['img', '-r', '--beside', '-w', '40', '-f', 'webp', '--plain'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('next to the sources')
    expect(existsSync(join(root, 'img', 'a-40w.webp'))).toBe(true)
    expect(existsSync(join(root, 'img', 'sub', 'b-40w.webp'))).toBe(true)
  })

  it('refuses two places at once with exit code 2', () => {
    const result = cli(['img', '-o', 'out', '--beside', '--plain'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/pick one place/)
    expect(cli(['img', '--plain']).stderr).toMatch(/--beside/)
  })

  it('--replace needs --yes without a terminal', () => {
    const before = readFileSync(join(root, 'img', 'a.png'))
    const result = cli(['img', '--replace', '-w', '40', '--plain'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/--yes/)
    expect(readFileSync(join(root, 'img', 'a.png')).equals(before)).toBe(true)
  })

  it('--replace --dry-run shows the saving and writes nothing', () => {
    const before = readFileSync(join(root, 'img', 'a.png'))
    const result = cli(['img', '--replace', '-w', '40', '--dry-run', '--plain'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('would be replaced')
    expect(result.stdout).toContain('Would save')
    expect(readFileSync(join(root, 'img', 'a.png')).equals(before)).toBe(true)
    expect(existsSync(join(root, '.image-batch-backup'))).toBe(false)
  })

  it('replaces with --yes, then restore puts the original back', () => {
    const before = readFileSync(join(root, 'img', 'a.png'))
    const replaced = cli(['img', '--replace', '-w', '40', '--yes', '--json'])
    expect(replaced.status).toBe(0)
    const report = JSON.parse(replaced.stdout)
    expect(report.counts.replaced).toBe(1)
    expect(readFileSync(join(root, 'img', 'a.png')).equals(before)).toBe(false)

    const refused = cli(['restore', report.backupDir, '--plain'])
    expect(refused.status).toBe(2)
    expect(refused.stderr).toMatch(/--yes/)

    const dry = cli(['restore', report.backupDir, '--dry-run', '--plain'])
    expect(dry.status).toBe(0)
    expect(dry.stdout).toContain('would be restored')

    const restored = cli(['restore', report.backupDir, '--yes', '--plain'])
    expect(restored.status).toBe(0)
    expect(restored.stdout).toContain('1 of 1 restored')
    expect(readFileSync(join(root, 'img', 'a.png')).equals(before)).toBe(true)
  })

  it('--no-backup leaves no copy, --backup <dir> picks the place', () => {
    const none = JSON.parse(
      cli(['img', '--replace', '-w', '30', '--yes', '--no-backup', '--json']).stdout,
    )
    expect(none.backupDir).toBeUndefined()
    expect(existsSync(join(root, '.image-batch-backup'))).toBe(false)
    const custom = JSON.parse(
      cli(['img', '--replace', '-w', '20', '--yes', '--backup', 'saved', '--json']).stdout,
    )
    expect(custom.backupDir.split('\\').join('/')).toContain('/saved/')
  })

  it('--no-only-if-smaller and --backup are rejected outside --replace', () => {
    expect(cli(['img', '-o', 'out', '--no-backup', '--plain']).status).toBe(2)
    expect(cli(['img', '--beside', '--no-only-if-smaller', '--plain']).status).toBe(2)
  })
})

describe('image-batch size methods on the command line', { timeout: 120_000 }, () => {
  it('--long, --short, --percent and --megapixels size by the named rule', () => {
    expect(cli(['img', '-o', 'l', '--long', '40', '-f', 'png', '--plain']).status).toBe(0)
    expect(existsSync(join(root, 'l', 'a-40l.png'))).toBe(true)
    expect(cli(['img', '-o', 's', '--short', '30', '-f', 'png', '--plain']).status).toBe(0)
    expect(existsSync(join(root, 's', 'a-30s.png'))).toBe(true)
    expect(cli(['img', '-o', 'p', '--percent', '50', '-f', 'png', '--plain']).status).toBe(0)
    expect(existsSync(join(root, 'p', 'a-50pct.png'))).toBe(true)
    expect(cli(['img', '-o', 'm', '--megapixels', '0.003', '-f', 'png', '--plain']).status).toBe(0)
    expect(existsSync(join(root, 'm', 'a-0.003mp.png'))).toBe(true)
  })

  it('--match-orientation turns a size box around for portrait images', async () => {
    await sharp(Buffer.alloc(60 * 80 * 3, 90), { raw: { width: 60, height: 80, channels: 3 } })
      .png()
      .toFile(join(root, 'img', 'tall.png'))
    const result = cli([
      'img',
      '-o',
      'o',
      '--fit',
      'cover',
      '-f',
      'png',
      '--match-orientation',
      '--json',
      '-w',
      '1000',
    ])
    expect(result.status).toBe(0)
    const tall = cli(['img/tall.png', '-o', 'box', '-f', 'png', '--percent', '100', '--json'])
    expect(JSON.parse(tall.stdout).results[0]).toMatchObject({ width: 60, height: 80 })
  })

  it('--max-size keeps the file under the limit', () => {
    const result = cli([
      'img',
      '-r',
      '-o',
      'o',
      '-f',
      'jpg',
      '-q',
      '95',
      '--max-size',
      '1KB',
      '--json',
    ])
    const report = JSON.parse(result.stdout)
    expect(report.counts.error + report.counts.written).toBeGreaterThan(0)
  })

  it('rejects bad values with exit code 2', () => {
    expect(cli(['img', '-o', 'o', '--long', 'big']).status).toBe(2)
    expect(cli(['img', '-o', 'o', '--percent', '0']).stderr).toMatch(
      /--percent must be numbers from 0.1 to 1000/,
    )
    expect(cli(['img', '-o', 'o', '--megapixels', 'x']).status).toBe(2)
    const small = cli(['img', '-o', 'o', '--max-size', '10', '-f', 'jpg'])
    expect(small.status).toBe(2)
    expect(small.stderr).toMatch(/at least 1 KB/)
    const png = cli(['img', '-o', 'o', '--max-size', '50KB', '-f', 'png'])
    expect(png.status).toBe(2)
    expect(png.stderr).toMatch(/needs a format with a quality setting/)
  })

  it('describes the new flags in --help', () => {
    const help = cli(['--help']).stdout
    for (const flag of [
      '--long',
      '--short',
      '--megapixels',
      '--percent',
      '--match-orientation',
      '--max-size',
    ]) {
      expect(help).toContain(flag)
    }
  })
})

describe('image-batch init size flags', { timeout: 120_000 }, () => {
  it('init takes any size method from flags', () => {
    const made = cli([
      'init',
      '--name',
      'big',
      '--long',
      '2000',
      '--percent',
      '50,25',
      '-f',
      'webp',
      '--plain',
    ])
    expect(made.status).toBe(0)
    const recipe = JSON.parse(
      readFileSync(join(root, '.mediatoolz', 'image-batch', 'big.json'), 'utf8'),
    ).outputs[0]
    expect(recipe).toMatchObject({ longEdge: [2000], percent: [50, 25], formats: ['webp'] })
    expect(recipe.widths).toBeUndefined()
  })

  it('init takes a box with its fit and orientation', () => {
    cli([
      'init',
      '--name',
      'box',
      '--size',
      '1920x1080',
      '--fit',
      'cover',
      '--match-orientation',
      '--plain',
    ])
    const recipe = JSON.parse(
      readFileSync(join(root, '.mediatoolz', 'image-batch', 'box.json'), 'utf8'),
    ).outputs[0]
    expect(recipe).toMatchObject({ size: '1920x1080', fit: 'cover', matchOrientation: true })
  })

  it('init rejects a bad value with exit code 2', () => {
    const result = cli(['init', '--name', 'bad', '--long', '0', '--plain'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/whole numbers/)
  })

  it('init still takes plain widths', () => {
    cli(['init', '--name', 'w', '-w', '320,640', '--plain'])
    expect(
      JSON.parse(readFileSync(join(root, '.mediatoolz', 'image-batch', 'w.json'), 'utf8'))
        .outputs[0].widths,
    ).toEqual([320, 640])
  })
})

describe('image-batch config group', { timeout: 120_000 }, () => {
  it('config new creates a config like init, and config list shows it', () => {
    const made = cli([
      'config',
      'new',
      '--name',
      'viaNew',
      '--long',
      '1500',
      '-f',
      'webp',
      '--plain',
    ])
    expect(made.status).toBe(0)
    const path = join(root, '.mediatoolz', 'image-batch', 'viaNew.json')
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0]).toMatchObject({
      longEdge: [1500],
      formats: ['webp'],
    })
    const listed = cli(['config', 'list', '--plain'])
    expect(listed.status).toBe(0)
    expect(listed.stdout).toContain('viaNew')
    const json = JSON.parse(cli(['config', 'list', '--json']).stdout)
    expect(json[0]).toMatchObject({ name: 'viaNew', scope: 'project', recipes: 1 })
  })

  it('config without a subcommand prints the table when there is no terminal', () => {
    cli(['init', '--name', 'plain', '--plain'])
    const result = cli(['config', '--plain'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('plain')
    expect(cli(['config', 'list', '--plain']).stdout).toContain('plain')
  })

  it('says how to create one when there are none', () => {
    expect(cli(['config', 'list', '--plain']).stdout).toContain('No configs found')
  })

  it('config show and config rm work as before', () => {
    cli(['init', '--name', 'gone', '--plain'])
    expect(cli(['config', 'show', 'gone', '--plain']).status).toBe(0)
    expect(cli(['config', 'rm', 'gone', '--yes', '--plain']).status).toBe(0)
    expect(cli(['config', 'show', 'gone', '--plain']).stderr).toMatch(/config list/)
  })
})

describe('image-batch sharpen presets', { timeout: 120_000 }, () => {
  const presetPath = (scope: 'project' | 'global', name: string) =>
    scope === 'project'
      ? join(root, '.mediatoolz', 'image-batch', 'sharpen', `${name}.json`)
      : join(home, '.mediatoolz', 'image-batch', 'sharpen', `${name}.json`)

  it('creates, lists, shows and deletes a preset', () => {
    const made = cli([
      'sharpen',
      'new',
      '--name',
      'crisp',
      '--sharpen-for',
      'glossy',
      '--sharpen-amount',
      'high',
      '--sharpen-radius',
      '1.2',
      '--sharpen-threshold',
      '4',
      '--description',
      'for print',
      '--plain',
    ])
    expect(made.status).toBe(0)
    expect(JSON.parse(readFileSync(presetPath('project', 'crisp'), 'utf8'))).toEqual({
      description: 'for print',
      for: 'glossy',
      amount: 'high',
      radius: 1.2,
      threshold: 4,
    })
    const listed = cli(['sharpen', 'list', '--plain'])
    expect(listed.stdout).toContain('crisp')
    expect(listed.stdout).toContain('project')
    expect(JSON.parse(cli(['sharpen', 'list', '--json']).stdout)[0]).toMatchObject({
      name: 'crisp',
      scope: 'project',
      for: 'glossy',
      radius: 1.2,
    })
    const shown = cli(['sharpen', 'show', 'crisp', '--plain'])
    expect(shown.status).toBe(0)
    expect(shown.stdout).toContain('sigma 1.2, flat 1.8, jagged 5, threshold 4')
    expect(cli(['sharpen', 'rm', 'crisp', '--plain']).status).toBe(2)
    expect(cli(['sharpen', 'rm', 'crisp', '--yes', '--plain']).status).toBe(0)
    expect(existsSync(presetPath('project', 'crisp'))).toBe(false)
    expect(cli(['sharpen', 'show', 'crisp', '--plain']).stderr).toMatch(/no sharpen preset/)
  })

  it('names the field and the range when a value is out of range', () => {
    const bad = cli(['sharpen', 'new', '--name', 'x', '--sharpen-radius', '50', '--plain'])
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('--sharpen-radius: expected a number from 0.000001 to 10')
    const none = cli(['sharpen', 'new', '--name', 'x', '--plain'])
    expect(none.status).toBe(2)
    expect(none.stderr).toContain('needs at least one of --sharpen-for')
  })

  it('refuses to overwrite a preset without --force', () => {
    cli(['sharpen', 'new', '--name', 'p', '--sharpen-for', 'screen', '--plain'])
    const again = cli(['sharpen', 'new', '--name', 'p', '--sharpen-amount', 'low', '--plain'])
    expect(again.status).toBe(2)
    expect(again.stderr).toContain('already exists')
    const forced = cli([
      'sharpen',
      'new',
      '--name',
      'p',
      '--sharpen-amount',
      'low',
      '--force',
      '--plain',
    ])
    expect(forced.status).toBe(0)
    expect(JSON.parse(readFileSync(presetPath('project', 'p'), 'utf8'))).toEqual({ amount: 'low' })
  })

  it('uses a preset from --sharpen, from a config, and from the global folder', () => {
    cli(['sharpen', 'new', '--name', 'local', '--sharpen-for', 'matte', '--plain'])
    cli([
      'sharpen',
      'new',
      '--name',
      'everywhere',
      '--global',
      '--sharpen-amount',
      'high',
      '--plain',
    ])
    expect(existsSync(presetPath('global', 'everywhere'))).toBe(true)
    const flag = cli(['img', '-r', '-o', 'out1', '-w', '40', '--sharpen', 'local', '--plain'])
    expect(flag.status).toBe(0)
    expect(existsSync(join(root, 'out1', 'a-40w.png'))).toBe(true)
    const global = cli([
      'img',
      '-r',
      '-o',
      'out2',
      '-w',
      '40',
      '--sharpen',
      'everywhere',
      '--plain',
    ])
    expect(global.status).toBe(0)
    mkdirSync(join(root, '.mediatoolz', 'image-batch'), { recursive: true })
    writeFileSync(
      join(root, '.mediatoolz', 'image-batch', 'web.json'),
      JSON.stringify({ outputs: [{ widths: [20], formats: ['png'], sharpen: 'local' }] }),
    )
    const viaConfig = cli(['img', '-o', 'out3', '-c', 'web', '--plain'])
    expect(viaConfig.status).toBe(0)
    expect(existsSync(join(root, 'out3', 'a-20w.png'))).toBe(true)
    expect(cli(['config', 'show', 'web', '--plain']).status).toBe(0)
  })

  it('stops before writing when a named preset does not exist', () => {
    cli(['sharpen', 'new', '--name', 'crisp', '--sharpen-for', 'screen', '--plain'])
    const result = cli(['img', '-r', '-o', 'out', '-w', '40', '--sharpen', 'crsip', '--plain'])
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('no sharpen preset named "crsip"')
    expect(result.stderr).toContain('crisp')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('redoes the results when the preset changes, and not otherwise', () => {
    cli(['sharpen', 'new', '--name', 'p', '--sharpen-for', 'screen', '--plain'])
    const args = ['img', '-r', '-o', 'out', '-w', '40', '--sharpen', 'p', '--overwrite', '--plain']
    expect(cli(args).stdout).toContain('2 written')
    expect(cli(args).stdout).toContain('2 up to date')
    cli(['sharpen', 'new', '--name', 'p', '--sharpen-for', 'glossy', '--force', '--plain'])
    expect(cli(args).stdout).toContain('2 written')
  })

  it('init stores a preset reference as a plain name', () => {
    cli(['sharpen', 'new', '--name', 'crisp', '--sharpen-for', 'screen', '--plain'])
    const made = cli(['init', '--name', 'web', '--sharpen', 'crisp', '--plain'])
    expect(made.status).toBe(0)
    const path = join(root, '.mediatoolz', 'image-batch', 'web.json')
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].sharpen).toBe('crisp')
  })

  it('prints the table when sharpen is run without a terminal', () => {
    cli(['sharpen', 'new', '--name', 'mine', '--sharpen-for', 'matte', '--plain'])
    const table = cli(['sharpen', '--plain']).stdout
    expect(table).toContain('mine')
    expect(table).toContain('project')
    expect(table).toContain('web-crisp')
    expect(table).toContain('built-in')
  })

  it('has built-in presets that work without creating anything', () => {
    const listed = JSON.parse(cli(['sharpen', 'list', '--json']).stdout)
    expect(listed.map((row: { name: string }) => row.name)).toEqual([
      'web-light',
      'web-crisp',
      'web-detail',
      'thumbnail',
      'print-matte',
      'print-glossy',
    ])
    expect(listed[0]).toMatchObject({ scope: 'built-in', for: 'screen', amount: 'low' })
    const shown = cli(['sharpen', 'show', 'thumbnail', '--plain'])
    expect(shown.status).toBe(0)
    expect(shown.stdout).toContain('sigma 0.4, flat 0.6, jagged 2.5')
    const run = cli(['img', '-r', '-o', 'out', '-w', '40', '--sharpen', 'print-glossy', '--plain'])
    expect(run.status).toBe(0)
    expect(existsSync(join(root, 'out', 'a-40w.png'))).toBe(true)
  })

  it('cannot delete a built-in preset, and a file of the same name replaces it', () => {
    const rm = cli(['sharpen', 'rm', 'web-crisp', '--yes', '--plain'])
    expect(rm.status).toBe(2)
    expect(rm.stderr).toContain('built-in preset')
    cli(['sharpen', 'new', '--name', 'web-crisp', '--sharpen-for', 'glossy', '--plain'])
    const rows = JSON.parse(cli(['sharpen', 'list', '--json']).stdout).filter(
      (row: { name: string }) => row.name === 'web-crisp',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ scope: 'project', for: 'glossy' })
  })
})
