import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sharp, SharpOptions } from 'sharp'
import { loadJournal } from '../commands/image-batch/backup.js'
import { parseConfig } from '../commands/image-batch/config.js'
import type { SharpFn } from '../commands/image-batch/plan.js'
import { renderImageBatchReport } from '../commands/image-batch/report.js'
import { renderRestoreReport, runRestore } from '../commands/image-batch/restore.js'
import { runImageBatch, type ImageBatchOptions } from '../commands/image-batch/run.js'
import { fakeTerminal } from './helpers/fake-terminal.js'

const sharp = createRequire(import.meta.url)('sharp') as SharpFn &
  ((input: unknown, options?: SharpOptions) => Sharp)

let root: string
let input: string

async function noisy(
  path: string,
  width: number,
  height: number,
  format: 'png' | 'jpg' = 'png',
  quality = 90,
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
const bytes = (path: string) => readFileSync(path)

function run(config: unknown, options: Partial<ImageBatchOptions> = {}) {
  return runImageBatch({
    paths: [input],
    cwd: root,
    recursive: true,
    config: parseConfig(config),
    interactive: false,
    cacheBase: root,
    ...options,
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ib-place-'))
  input = join(root, 'in')
  await noisy(join(input, 'a.png'), 600, 400)
  await noisy(join(input, 'sub', 'b.jpg'), 800, 600, 'jpg')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('choosing the place for results', () => {
  const config = { outputs: [{ widths: [100], formats: ['webp'] }] }

  it('needs exactly one of --out, --beside and --replace', async () => {
    await expect(run(config)).rejects.toThrow(/--out <dir>, --beside .* or --replace/)
    await expect(run(config, { out: 'o', beside: true })).rejects.toThrow(/pick one place/)
    await expect(run(config, { out: 'o', replace: true })).rejects.toThrow(/pick one place/)
    await expect(run(config, { beside: true, replace: true })).rejects.toThrow(/pick one place/)
  })

  it('rejects options that belong to another place', async () => {
    await expect(run(config, { beside: true, flat: true })).rejects.toThrow(
      /--flat only makes sense with --out/,
    )
    await expect(run(config, { out: 'o', backup: false })).rejects.toThrow(/belong to --replace/)
    await expect(run(config, { beside: true, onlyIfSmaller: false })).rejects.toThrow(
      /belong to --replace/,
    )
    await expect(
      run(config, { replace: true, assumeYes: true, overrides: { name: 'x.{format}' } }),
    ).rejects.toThrow(/--name has no effect with --replace/)
  })
})

describe('--beside', () => {
  const config = { outputs: [{ widths: [100], formats: ['webp'] }] }

  it('writes each result into its source folder and leaves the sources alone', async () => {
    const before = bytes(join(input, 'a.png'))
    const report = await run(config, { beside: true })
    expect(report.placement).toBe('beside')
    expect(report.counts.written).toBe(2)
    expect(existsSync(join(input, 'a-100w.webp'))).toBe(true)
    expect(existsSync(join(input, 'sub', 'b-100w.webp'))).toBe(true)
    expect(bytes(join(input, 'a.png')).equals(before)).toBe(true)
    expect((await meta(join(input, 'a-100w.webp'))).width).toBe(100)
  })

  it('does not take its own results for sources on the next run', async () => {
    await run(config, { beside: true })
    const again = await run(config, { beside: true })
    expect(again.sources.map((s) => s.file)).toEqual(['a.png', 'sub/b.jpg'])
    expect(again.counts['up-to-date']).toBe(2)
    expect(again.derived.sort()).toEqual(['a-100w.webp', 'sub/b-100w.webp'])
    expect(readdirSync(input).filter((n) => n.endsWith('.webp'))).toEqual(['a-100w.webp'])
  })

  it('still recognizes earlier results when the record of them is gone', async () => {
    await run(config, { beside: true })
    const again = await run(config, { beside: true, cache: false, overwrite: 'skip' })
    expect(again.sources.map((s) => s.file)).toEqual(['a.png', 'sub/b.jpg'])
    expect(again.derived.length).toBe(2)
    expect(again.counts.skipped).toBe(2)
    expect(existsSync(join(input, 'a-100w-100w.webp'))).toBe(false)
  })

  it('refuses a name that would land on the source itself and points at --replace', async () => {
    await expect(
      run({ outputs: [{ formats: ['png'], name: '{dir}/{name}.{format}' }] }, { beside: true }),
    ).rejects.toThrow(/would overwrite the source file a\.png.*--replace/)
  })

  it('treats a single file as its own folder', async () => {
    const report = await run(config, { beside: true, paths: [join(input, 'sub', 'b.jpg')] })
    expect(report.results[0]?.output).toBe('b-100w.webp')
    expect(existsSync(join(input, 'sub', 'b-100w.webp'))).toBe(true)
  })

  it('shows where the results went', async () => {
    const report = await run(config, { beside: true })
    const text = renderImageBatchReport(report, { plain: true })
    expect(text).toContain('next to the sources')
    const again = await run(config, { beside: true })
    expect(renderImageBatchReport(again, { plain: true })).toContain(
      'look like results of an earlier run',
    )
  })
})

describe('--replace', () => {
  const shrink = { outputs: [{ widths: [300] }] }

  it('rewrites the source in its own format and keeps a copy of the original', async () => {
    const before = bytes(join(input, 'a.png'))
    const report = await run(shrink, { replace: true, assumeYes: true })
    expect(report.placement).toBe('replace')
    expect(report.counts.replaced).toBe(2)
    expect(report.exitCode).toBe(0)
    const info = await meta(join(input, 'a.png'))
    expect([info.format, info.width, info.height]).toEqual(['png', 300, 200])
    expect((await meta(join(input, 'sub', 'b.jpg'))).format).toBe('jpeg')
    expect(bytes(join(input, 'a.png')).length).toBeLessThan(before.length)
    const saved = readFileSync(join(report.backupDir as string, 'in', 'a.png'))
    expect(saved.equals(before)).toBe(true)
  })

  it('writes a journal with sizes and hashes', async () => {
    const report = await run(shrink, { replace: true, assumeYes: true })
    const journal = loadJournal(report.backupDir as string)
    expect(journal.entries).toHaveLength(2)
    const entry = journal.entries.find((e) => e.path.endsWith('a.png'))
    expect(entry).toMatchObject({ bytesBefore: expect.any(Number), bytesAfter: expect.any(Number) })
    expect(entry?.bytesAfter).toBeLessThan(entry?.bytesBefore ?? 0)
    expect(entry?.hashBefore).not.toBe(entry?.hashAfter)
  })

  it('only replaces what gets smaller, and says what stayed', async () => {
    await noisy(join(input, 'tiny.jpg'), 600, 400, 'jpg', 30)
    const original = bytes(join(input, 'tiny.jpg'))
    const report = await run(
      { outputs: [{ formats: { jpg: { quality: 100 } } }] },
      { replace: true, assumeYes: true, paths: [join(input, 'tiny.jpg')] },
    )
    expect(report.counts.kept).toBe(1)
    expect(report.counts.replaced).toBe(0)
    expect(bytes(join(input, 'tiny.jpg')).equals(original)).toBe(true)
    expect(report.backupDir).toBeUndefined()
    expect(renderImageBatchReport(report, { plain: true })).toContain('kept (not smaller)')
  })

  it('replaces even when bigger with --no-only-if-smaller', async () => {
    await noisy(join(input, 'tiny.jpg'), 600, 400, 'jpg', 30)
    const original = bytes(join(input, 'tiny.jpg'))
    const report = await run(
      { outputs: [{ formats: { jpg: { quality: 100 } } }] },
      { replace: true, assumeYes: true, onlyIfSmaller: false, paths: [join(input, 'tiny.jpg')] },
    )
    expect(report.counts.replaced).toBe(1)
    expect(bytes(join(input, 'tiny.jpg')).length).toBeGreaterThan(original.length)
  })

  it('does not process a file again that it already processed with the same settings', async () => {
    await run(shrink, { replace: true, assumeYes: true })
    const afterFirst = bytes(join(input, 'a.png'))
    const again = await run(shrink, { replace: true, assumeYes: true })
    expect(again.counts['already-processed']).toBe(2)
    expect(again.counts.replaced).toBe(0)
    expect(again.backupDir).toBeUndefined()
    expect(bytes(join(input, 'a.png')).equals(afterFirst)).toBe(true)
    expect(readdirSync(join(root, '.image-batch-backup'))).toHaveLength(1)
  })

  it('processes it again when the settings change', async () => {
    await run(shrink, { replace: true, assumeYes: true })
    const again = await run({ outputs: [{ widths: [150] }] }, { replace: true, assumeYes: true })
    expect(again.counts.replaced).toBe(2)
    expect((await meta(join(input, 'a.png'))).width).toBe(150)
  })

  it('does not process a kept file again either', async () => {
    await noisy(join(input, 'tiny.jpg'), 600, 400, 'jpg', 30)
    const options = { replace: true, assumeYes: true, paths: [join(input, 'tiny.jpg')] }
    const config = { outputs: [{ formats: { jpg: { quality: 100 } } }] }
    await run(config, options)
    expect((await run(config, options)).counts['already-processed']).toBe(1)
  })

  it('re-processes everything with --force', async () => {
    await run(shrink, { replace: true, assumeYes: true })
    const again = await run(
      { outputs: [{ widths: [300] }] },
      { replace: true, assumeYes: true, force: true, onlyIfSmaller: false },
    )
    expect(again.counts.replaced).toBe(2)
  })

  it('does not scan its own backups on the next run', async () => {
    await run(shrink, { replace: true, assumeYes: true })
    const again = await run(
      { outputs: [{ widths: [100] }] },
      { replace: true, assumeYes: true, paths: [root] },
    )
    expect(again.sources.every((s) => !s.file.includes('image-batch-backup'))).toBe(true)
  })

  it('lets you pick the backup folder, or none', async () => {
    const custom = await run(shrink, {
      replace: true,
      assumeYes: true,
      backup: join(root, 'saved'),
    })
    expect(custom.backupDir?.startsWith(join(root, 'saved'))).toBe(true)
    expect(existsSync(join(custom.backupDir as string, 'journal.json'))).toBe(true)
    await noisy(join(input, 'c.png'), 600, 400)
    const none = await run(shrink, {
      replace: true,
      assumeYes: true,
      backup: false,
      paths: [join(input, 'c.png')],
    })
    expect(none.counts.replaced).toBe(1)
    expect(none.backupDir).toBeUndefined()
    expect(renderImageBatchReport(none, { plain: true })).toContain('no backup')
  })

  it('refuses without confirmation when nobody can be asked', async () => {
    const before = bytes(join(input, 'a.png'))
    await expect(run(shrink, { replace: true })).rejects.toThrow(/pass --yes/)
    expect(bytes(join(input, 'a.png')).equals(before)).toBe(true)
  })

  it('asks in a terminal, and a "no" changes nothing', async () => {
    const before = bytes(join(input, 'a.png'))
    const report = await run(shrink, {
      replace: true,
      interactive: true,
      io: fakeTerminal(['n']),
      style: { plain: true },
    })
    expect(report.cancelled).toBe(true)
    expect(report.exitCode).toBe(1)
    expect(bytes(join(input, 'a.png')).equals(before)).toBe(true)
    expect(existsSync(join(root, '.image-batch-backup'))).toBe(false)
    expect(renderImageBatchReport(report, { plain: true })).toContain('Cancelled')
  })

  it('goes ahead on "y" and mentions the backup in the question', async () => {
    const terminal = fakeTerminal(['y'])
    const report = await run(shrink, {
      replace: true,
      interactive: true,
      io: terminal,
      style: { plain: true },
    })
    expect(report.counts.replaced).toBe(2)
    expect(terminal.written).toContain('Replace 2 images')
    expect(terminal.written).toContain('originals are copied to')
  })

  it('warns in the question when there is no backup', async () => {
    const terminal = fakeTerminal(['n'])
    await run(shrink, {
      replace: true,
      backup: false,
      interactive: true,
      io: terminal,
      style: { plain: true },
    })
    expect(terminal.written).toContain('NO backup')
  })

  it('previews with real numbers and writes nothing', async () => {
    const before = bytes(join(input, 'a.png'))
    const report = await run(shrink, { replace: true, dryRun: true })
    expect(report.counts['would-replace']).toBe(2)
    expect(report.results.every((r) => (r.bytes ?? 0) < (r.before ?? 0))).toBe(true)
    expect(bytes(join(input, 'a.png')).equals(before)).toBe(true)
    expect(existsSync(join(root, '.image-batch-backup'))).toBe(false)
    const text = renderImageBatchReport(report, { plain: true })
    expect(text).toContain('would be replaced')
    expect(text).toContain('Would save')
  })

  it('needs one result per image, in the image’s own format', async () => {
    await expect(
      run({ outputs: [{ widths: [100, 200] }] }, { replace: true, assumeYes: true }),
    ).rejects.toThrow(/one result over each image/)
    await expect(
      run({ outputs: [{ formats: ['webp'] }] }, { replace: true, assumeYes: true }),
    ).rejects.toThrow(/keeps each file's own format.*png.*webp/)
    expect(bytes(join(input, 'a.png')).length).toBeGreaterThan(0)
  })

  it('leaves svg files alone without calling it a failure', async () => {
    writeFileSync(
      join(input, 'v.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    )
    const report = await run(shrink, { replace: true, assumeYes: true })
    expect(report.vectors).toEqual(['v.svg'])
    expect(report.failures).toEqual([])
    expect(report.counts.replaced).toBe(2)
    expect(report.exitCode).toBe(0)
  })

  it('summarizes the saving and tells how to undo', async () => {
    const report = await run(shrink, { replace: true, assumeYes: true })
    const text = renderImageBatchReport(report, { plain: true })
    expect(text).toContain('2 replaced')
    expect(text).toMatch(/Saved .* \(\d+% of/)
    expect(text).toContain('image-batch restore')
    expect(text).toContain('in place')
  })

  it('lists the real source in the manifest', async () => {
    const emit = join(root, 'm.json')
    await run(shrink, { replace: true, assumeYes: true, emit })
    const manifest = JSON.parse(readFileSync(emit, 'utf8'))
    expect(manifest.sources['a.png'].outputs[0]).toMatchObject({ path: 'a.png', width: 300 })
  })
})

describe('restore', () => {
  const shrink = { outputs: [{ widths: [300] }] }

  it('puts the originals back', async () => {
    const before = bytes(join(input, 'a.png'))
    const replaced = await run(shrink, { replace: true, assumeYes: true })
    const report = await runRestore({
      dir: replaced.backupDir as string,
      cwd: root,
      assumeYes: true,
    })
    expect(report.counts.restored).toBe(2)
    expect(report.exitCode).toBe(0)
    expect(bytes(join(input, 'a.png')).equals(before)).toBe(true)
    expect((await meta(join(input, 'a.png'))).width).toBe(600)
  })

  it('lets the next --replace run process the restored files again', async () => {
    const replaced = await run(shrink, { replace: true, assumeYes: true })
    await runRestore({ dir: replaced.backupDir as string, cwd: root, assumeYes: true })
    const again = await run(shrink, { replace: true, assumeYes: true })
    expect(again.counts.replaced).toBe(2)
  })

  it('shows what it would do without writing', async () => {
    const replaced = await run(shrink, { replace: true, assumeYes: true })
    const afterReplace = bytes(join(input, 'a.png'))
    const report = await runRestore({ dir: replaced.backupDir as string, cwd: root, dryRun: true })
    expect(report.counts['would-restore']).toBe(2)
    expect(bytes(join(input, 'a.png')).equals(afterReplace)).toBe(true)
    expect(renderRestoreReport(report, { plain: true })).toContain('would be restored')
  })

  it('leaves a file alone that changed after it was replaced, unless forced', async () => {
    const replaced = await run(shrink, { replace: true, assumeYes: true })
    writeFileSync(join(input, 'a.png'), 'edited by hand')
    const careful = await runRestore({
      dir: replaced.backupDir as string,
      cwd: root,
      assumeYes: true,
    })
    expect(careful.counts.modified).toBe(1)
    expect(careful.counts.restored).toBe(1)
    expect(careful.exitCode).toBe(1)
    expect(readFileSync(join(input, 'a.png'), 'utf8')).toBe('edited by hand')
    expect(renderRestoreReport(careful, { plain: true })).toContain('use --force')
    const forced = await runRestore({
      dir: replaced.backupDir as string,
      cwd: root,
      assumeYes: true,
      force: true,
    })
    expect(forced.counts.restored).toBe(2)
    expect((await meta(join(input, 'a.png'))).width).toBe(600)
  })

  it('reports a missing or damaged backup copy', async () => {
    const replaced = await run(shrink, { replace: true, assumeYes: true })
    const journal = loadJournal(replaced.backupDir as string)
    rmSync(journal.entries[0]?.backup as string)
    writeFileSync(journal.entries[1]?.backup as string, 'corrupted')
    const report = await runRestore({
      dir: replaced.backupDir as string,
      cwd: root,
      assumeYes: true,
    })
    expect(report.counts['missing-backup']).toBe(1)
    expect(report.counts['damaged-backup']).toBe(1)
    expect(report.exitCode).toBe(1)
  })

  it('restores a file that was deleted since', async () => {
    const replaced = await run(shrink, { replace: true, assumeYes: true })
    rmSync(join(input, 'a.png'))
    const report = await runRestore({
      dir: replaced.backupDir as string,
      cwd: root,
      assumeYes: true,
    })
    expect(report.counts.restored).toBe(2)
    expect(existsSync(join(input, 'a.png'))).toBe(true)
  })

  it('needs --yes without a terminal, asks in one, and rejects a folder with no journal', async () => {
    const replaced = await run(shrink, { replace: true, assumeYes: true })
    await expect(
      runRestore({ dir: replaced.backupDir as string, cwd: root, interactive: false }),
    ).rejects.toThrow(/--yes/)
    const declined = await runRestore({
      dir: replaced.backupDir as string,
      cwd: root,
      interactive: true,
      io: fakeTerminal(['n']),
      style: { plain: true },
    })
    expect(declined.cancelled).toBe(true)
    expect(renderRestoreReport(declined, { plain: true })).toContain('Cancelled')
    const accepted = await runRestore({
      dir: replaced.backupDir as string,
      cwd: root,
      interactive: true,
      io: fakeTerminal(['y']),
      style: { plain: true },
    })
    expect(accepted.counts.restored).toBe(2)
    await expect(runRestore({ dir: root, cwd: root, assumeYes: true })).rejects.toThrow(
      /no journal\.json/,
    )
  })

  it('accepts a relative folder and survives untouched mtimes', async () => {
    const replaced = await run(shrink, { replace: true, assumeYes: true })
    const old = new Date(2020, 1, 1)
    utimesSync(join(input, 'a.png'), old, old)
    const report = await runRestore({
      dir: replaced.backupDir as string,
      cwd: root,
      assumeYes: true,
    })
    expect(report.counts.restored).toBe(2)
  })
})
