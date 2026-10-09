import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sharp, SharpOptions } from 'sharp'
import { createStyle } from '../format/style.js'
import { parseConfig } from '../commands/image-batch/config.js'
import {
  buildStarterConfig,
  describeConfigLines,
  listConfigRows,
  manageConfigs,
  removeConfigFile,
  renderConfigTable,
  runInit,
  type ManageEnv,
} from '../commands/image-batch/manage.js'
import { manageSharpenPresets, runSharpenNew } from '../commands/image-batch/sharpen-manage.js'
import { createOverwriteResolver } from '../commands/image-batch/overwrite.js'
import type { SharpFn } from '../commands/image-batch/plan.js'
import { runImageBatch } from '../commands/image-batch/run.js'
import {
  KeyReader,
  askText,
  isInteractive,
  multiSelect,
  parseKeys,
  promptChoice,
  singleSelect,
  type SelectItem,
  type TerminalIO,
} from '../utils/tty.js'

const sharp = createRequire(import.meta.url)('sharp') as SharpFn &
  ((input: unknown, options?: SharpOptions) => Sharp)

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'
const SPACE = ' '

import { fakeTerminal } from './helpers/fake-terminal.js'

const style = createStyle({ plain: true })
const items = (...labels: string[]): SelectItem<string>[] =>
  labels.map((label) => ({ label, value: label }))

describe('key parsing', () => {
  it('reads arrows, enter, escape, backspace and text', () => {
    expect(parseKeys(`${UP}${DOWN}\x1b[C\x1b[D`).map((k) => k.name)).toEqual([
      'up',
      'down',
      'right',
      'left',
    ])
    expect(parseKeys('\r\n').map((k) => k.name)).toEqual(['enter'])
    expect(parseKeys('\r').map((k) => k.name)).toEqual(['enter'])
    expect(parseKeys(ESC).map((k) => k.name)).toEqual(['escape'])
    expect(parseKeys('\x7f').map((k) => k.name)).toEqual(['backspace'])
    expect(parseKeys('ab c').map((k) => k.name)).toEqual(['a', 'b', 'space', 'c'])
    expect(parseKeys('\x03')[0]).toMatchObject({ name: 'c', ctrl: true })
    expect(parseKeys('\x1b[5~\x1b[6~\x1b[H\x1b[F').map((k) => k.name)).toEqual([
      'pageup',
      'pagedown',
      'home',
      'end',
    ])
    expect(parseKeys('\x1bOA').map((k) => k.name)).toEqual(['up'])
  })

  it('reads a pasted run of keys in order', () => {
    expect(parseKeys(`ab${ENTER}`).map((k) => k.name)).toEqual(['a', 'b', 'enter'])
  })

  it('restores the terminal after reading', async () => {
    const terminal = fakeTerminal(['x'])
    const reader = new KeyReader(terminal.input)
    expect((await reader.next()).name).toBe('x')
    reader.close()
    expect(terminal.rawModes).toEqual([true, false])
  })

  it('knows whether it can be interactive', () => {
    expect(isInteractive(fakeTerminal([], true))).toBe(true)
    expect(isInteractive(fakeTerminal([], false))).toBe(false)
  })
})

describe('promptChoice', () => {
  const choices = [
    { key: 'y', label: 'yes' },
    { key: 'n', label: 'no' },
    { key: 'q', label: 'quit' },
  ]

  it('returns the pressed key, case-insensitively', async () => {
    expect(await promptChoice(fakeTerminal(['Y']), 'ok?', choices, style)).toBe('y')
  })

  it('ignores keys that are not choices', async () => {
    expect(await promptChoice(fakeTerminal(['x', 'z', 'n']), 'ok?', choices, style)).toBe('n')
  })

  it('uses the fallback on enter', async () => {
    expect(await promptChoice(fakeTerminal([ENTER]), 'ok?', choices, style, 'n')).toBe('n')
  })

  it('treats ctrl-c as quit', async () => {
    expect(await promptChoice(fakeTerminal(['\x03']), 'ok?', choices, style)).toBe('q')
  })

  it('prints the question and the keys', async () => {
    const terminal = fakeTerminal(['y'])
    await promptChoice(terminal, 'Overwrite?', choices, style)
    expect(terminal.written).toContain('Overwrite?')
    expect(terminal.written).toContain('[y] yes')
  })
})

describe('selectors', () => {
  it('picks several items with space and confirms with enter', async () => {
    const terminal = fakeTerminal([SPACE, SPACE, DOWN, SPACE, ENTER])
    const picked = await multiSelect(terminal, items('a', 'b', 'c', 'd'), { title: 't' }, style)
    expect(picked).toEqual(['a', 'b', 'd'])
  })

  it('starts from the preselected items', async () => {
    const preset = items('a', 'b').map((item) => ({ ...item, selected: true }))
    expect(await multiSelect(fakeTerminal([ENTER]), preset, { title: 't' }, style)).toEqual([
      'a',
      'b',
    ])
  })

  it('has select-all, none and invert', async () => {
    expect(
      await multiSelect(fakeTerminal(['a', ENTER]), items('x', 'y', 'z'), { title: 't' }, style),
    ).toEqual(['x', 'y', 'z'])
    expect(
      await multiSelect(fakeTerminal(['a', 'n', ENTER]), items('x', 'y'), { title: 't' }, style),
    ).toEqual([])
    expect(
      await multiSelect(
        fakeTerminal([SPACE, 'i', ENTER]),
        items('x', 'y', 'z'),
        { title: 't' },
        style,
      ),
    ).toEqual(['y', 'z'])
  })

  it('filters by substring and acts only on what is visible', async () => {
    const terminal = fakeTerminal(['/', 'b', 'a', 'r', ENTER, 'a', ESC, ENTER])
    const picked = await multiSelect(
      terminal,
      items('foo', 'bar', 'barn', 'baz'),
      { title: 't', filterable: true },
      style,
    )
    expect(picked).toEqual(['bar', 'barn'])
  })

  it('backspace edits the filter and escape clears it', async () => {
    const terminal = fakeTerminal(['/', 'z', 'x', '\x7f', '\x7f', ESC, 'a', ENTER])
    const picked = await multiSelect(
      terminal,
      items('one', 'two'),
      { title: 't', filterable: true },
      style,
    )
    expect(picked).toEqual(['one', 'two'])
  })

  it('cancels with q, escape or ctrl-c', async () => {
    expect(await multiSelect(fakeTerminal(['q']), items('a'), { title: 't' }, style)).toBeNull()
    expect(await multiSelect(fakeTerminal([ESC]), items('a'), { title: 't' }, style)).toBeNull()
    expect(await multiSelect(fakeTerminal(['\x03']), items('a'), { title: 't' }, style)).toBeNull()
  })

  it('wraps the cursor and moves with k and j, home and end', async () => {
    expect(
      await singleSelect(fakeTerminal([UP, ENTER]), items('a', 'b', 'c'), { title: 't' }, style),
    ).toBe('c')
    expect(
      await singleSelect(
        fakeTerminal(['j', 'j', ENTER]),
        items('a', 'b', 'c'),
        { title: 't' },
        style,
      ),
    ).toBe('c')
    expect(
      await singleSelect(
        fakeTerminal(['\x1b[F', ENTER]),
        items('a', 'b', 'c'),
        { title: 't' },
        style,
      ),
    ).toBe('c')
    expect(
      await singleSelect(
        fakeTerminal(['\x1b[F', '\x1b[H', ENTER]),
        items('a', 'b', 'c'),
        { title: 't' },
        style,
      ),
    ).toBe('a')
  })

  it('scrolls through a long list', async () => {
    const many = items(...Array.from({ length: 80 }, (_, i) => `item-${i}`))
    const terminal = fakeTerminal(['\x1b[6~', '\x1b[6~', ENTER])
    const picked = await singleSelect(terminal, many, { title: 't', pageSize: 10 }, style)
    expect(picked).toBe('item-20')
    expect(terminal.written).toContain('of 80')
  })

  it('shows the hint, the counter and a cursor marker', async () => {
    const terminal = fakeTerminal(['q'])
    await multiSelect(
      terminal,
      [{ label: 'photo.png', hint: '800×600', value: 1 }],
      { title: 'Pick' },
      style,
    )
    expect(terminal.written).toContain('Pick')
    expect(terminal.written).toContain('photo.png')
    expect(terminal.written).toContain('800×600')
    expect(terminal.written).toContain('0 selected of 1')
  })

  it('hides the cursor while active and brings it back', async () => {
    const terminal = fakeTerminal(['q'])
    await singleSelect(terminal, items('a'), { title: 't' }, style)
    expect(terminal.written).toContain('\x1b[?25l')
    expect(terminal.written.endsWith('\x1b[?25h')).toBe(true)
  })

  it('does not crash on an empty list', async () => {
    expect(
      await multiSelect(fakeTerminal([ENTER]), [], { title: 't', emptyMessage: 'nothing' }, style),
    ).toEqual([])
  })
})

describe('askText', () => {
  it('starts from the initial text and edits it', async () => {
    expect(await askText(fakeTerminal(['\x7f', 'x', ENTER]), 'name', style, 'abc')).toBe('abx')
  })

  it('returns null on escape and ctrl-c', async () => {
    expect(await askText(fakeTerminal([ESC]), 'name', style)).toBeNull()
    expect(await askText(fakeTerminal(['\x03']), 'name', style)).toBeNull()
  })
})

describe('overwrite resolver', () => {
  const info = {
    outRel: 'a.webp',
    sourceRel: 'a.png',
    existingBytes: 1,
    reason: 'unknown' as const,
  }

  it('answers by mode without asking', async () => {
    expect(await createOverwriteResolver('overwrite').decide(info)).toBe('write')
    expect(await createOverwriteResolver('skip').decide(info)).toBe('skip')
    expect(await createOverwriteResolver('error').decide(info)).toBe('fail')
    expect(await createOverwriteResolver('ask').decide(info)).toBe('skip')
  })

  it('remembers all and none', async () => {
    let asks = 0
    const all = createOverwriteResolver('ask', async () => {
      asks += 1
      return 'all'
    })
    expect(await all.decide(info)).toBe('write')
    expect(await all.decide(info)).toBe('write')
    expect(asks).toBe(1)
    const none = createOverwriteResolver('ask', async () => 'none')
    expect(await none.decide(info)).toBe('skip')
    expect(await none.decide(info)).toBe('skip')
  })

  it('throws on quit', async () => {
    await expect(createOverwriteResolver('ask', async () => 'quit').decide(info)).rejects.toThrow()
  })
})

describe('image-batch in a terminal', () => {
  let root: string
  let input: string
  let output: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ib-tty-'))
    input = join(root, 'in')
    output = join(root, 'out')
    mkdirSync(input, { recursive: true })
    for (const name of ['a', 'b', 'c']) {
      await sharp(Buffer.alloc(60 * 40 * 3, 90), { raw: { width: 60, height: 40, channels: 3 } })
        .png()
        .toFile(join(input, `${name}.png`))
    }
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const base = () => ({
    paths: [input],
    cwd: root,
    out: output,
    config: parseConfig({ outputs: [{ widths: [30], formats: ['webp'] }] }),
    cacheBase: root,
  })

  it('--select processes only the chosen images', async () => {
    const terminal = fakeTerminal(['n', SPACE, DOWN, SPACE, ENTER])
    const report = await runImageBatch({
      ...base(),
      select: true,
      io: terminal,
      interactive: true,
      style: { plain: true },
    })
    expect(report.results.map((r) => r.source)).toEqual(['a.png', 'c.png'])
    expect(terminal.written).toContain('Pick the images to process (3 found)')
    expect(existsSync(join(output, 'b-30w.webp'))).toBe(false)
  })

  it('--select starts with everything chosen', async () => {
    const report = await runImageBatch({
      ...base(),
      select: true,
      io: fakeTerminal([ENTER]),
      interactive: true,
      style: { plain: true },
    })
    expect(report.results).toHaveLength(3)
  })

  it('--select stops cleanly when nothing is chosen', async () => {
    const report = await runImageBatch({
      ...base(),
      select: true,
      io: fakeTerminal(['n', ENTER]),
      interactive: true,
      style: { plain: true },
    })
    expect(report.nothingSelected).toBe(true)
    expect(existsSync(output)).toBe(false)
  })

  it('--select needs a terminal', async () => {
    await expect(
      runImageBatch({ ...base(), select: true, io: fakeTerminal([], false), interactive: false }),
    ).rejects.toThrow(/--list/)
  })

  it('asks about the first conflict through the terminal and remembers "all"', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-30w.webp'), 'x')
    writeFileSync(join(output, 'b-30w.webp'), 'x')
    const terminal = fakeTerminal(['a'])
    const report = await runImageBatch({
      ...base(),
      io: terminal,
      interactive: true,
      style: { plain: true },
    })
    expect(report.counts.written).toBe(3)
    expect(terminal.written).toContain('Output exists:')
    expect(terminal.written).toContain('a-30w.webp')
    expect(terminal.written.match(/Output exists:/g)).toHaveLength(1)
  })

  it('asks again after a single "yes" and honors "skip"', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-30w.webp'), 'x')
    writeFileSync(join(output, 'b-30w.webp'), 'x')
    const terminal = fakeTerminal(['y', 's'])
    const report = await runImageBatch({
      ...base(),
      io: terminal,
      interactive: true,
      style: { plain: true },
    })
    expect(terminal.written.match(/Output exists:/g)).toHaveLength(2)
    expect(report.counts.skipped).toBe(1)
    expect(readFileSync(join(output, 'b-30w.webp'), 'utf8')).toBe('x')
  })

  it('quits on q', async () => {
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'a-30w.webp'), 'x')
    const report = await runImageBatch({
      ...base(),
      io: fakeTerminal(['q']),
      interactive: true,
      style: { plain: true },
    })
    expect(report.aborted).toBe(true)
  })
})

describe('config management', () => {
  let root: string
  let env: ManageEnv
  let logged: string[]

  function envWith(terminal: TerminalIO): ManageEnv {
    logged = []
    return {
      cwd: join(root, 'proj'),
      io: terminal,
      style: { plain: true },
      globalDir: join(root, 'home', '.mediatoolz', 'image-batch'),
      log: (text) => logged.push(text),
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ib-manage-'))
    mkdirSync(join(root, 'proj'), { recursive: true })
    env = envWith(fakeTerminal([], false))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const writeConfig = (name: string, value: unknown, scope: 'proj' | 'global' = 'proj') => {
    const dir =
      scope === 'proj'
        ? join(root, 'proj', '.mediatoolz', 'image-batch')
        : join(root, 'home', '.mediatoolz', 'image-batch')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`)
    return join(dir, `${name}.json`)
  }

  it('builds a valid starter config', () => {
    const config = buildStarterConfig(
      { widths: [100, 200], formats: ['webp'], thumbnail: true, hazehash: true, quality: 'medium' },
      'x',
    )
    expect(parseConfig(config).outputs).toHaveLength(2)
    expect(config.placeholders).toEqual({ hazehash: { budget: 28 } })
  })

  it('init writes a config from flags without a terminal', async () => {
    const path = await runInit(env, { name: 'web', widths: [320], formats: ['webp'] })
    expect(path).toBe(join(root, 'proj', '.mediatoolz', 'image-batch', 'web.json'))
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].widths).toEqual([320])
  })

  it('init can save globally', async () => {
    const path = await runInit(env, { name: 'shared', global: true })
    expect(path).toBe(join(root, 'home', '.mediatoolz', 'image-batch', 'shared.json'))
  })

  it('init refuses to overwrite, and needs a name without a terminal', async () => {
    await runInit(env, { name: 'web' })
    await expect(runInit(env, { name: 'web' })).rejects.toThrow(/already exists/)
    await expect(runInit(env, { name: 'web', force: true })).resolves.toBeDefined()
    await expect(runInit(env, {})).rejects.toThrow(/--name/)
    await expect(runInit(env, { name: 'bad name!' })).rejects.toThrow(/not a usable config name/)
  })

  it('init asks everything in a terminal', async () => {
    const terminal = fakeTerminal([
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ENTER,
      'y',
      'y',
    ])
    const path = await runInit(envWith(terminal), {})
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(path.endsWith('web.json')).toBe(true)
    expect(written.outputs[0]).toMatchObject({
      widths: [400, 800, 1200],
      formats: ['avif', 'webp', 'jpg'],
      quality: 'high',
    })
    expect(written.outputs[1].id).toBe('thumb')
    expect(written.placeholders).toEqual({ hazehash: { budget: 28 } })
  })

  it('init asks about sharpening and stores the chosen target and amount', async () => {
    const terminal = fakeTerminal([
      ...[ENTER, ENTER, ENTER, ENTER, ENTER, DOWN, DOWN, ENTER, ENTER],
      ...[DOWN, DOWN, DOWN, ENTER, DOWN, DOWN, ENTER],
      ...['n', 'n'],
    ])
    const written = JSON.parse(readFileSync(await runInit(envWith(terminal), {}), 'utf8'))
    expect(written.outputs[0].sharpen).toEqual({ for: 'glossy', amount: 'high' })
  })

  describe('sharpen presets', () => {
    const presetDir = () => join(root, 'proj', '.mediatoolz', 'image-batch', 'sharpen')
    const writePreset = (name: string, value: unknown) => {
      mkdirSync(presetDir(), { recursive: true })
      writeFileSync(join(presetDir(), `${name}.json`), JSON.stringify(value))
    }

    it('sharpen new asks for the target and amount, and for the fine settings when wanted', async () => {
      const terminal = fakeTerminal([
        ...[ENTER, ENTER, DOWN, DOWN, ENTER, DOWN, DOWN, ENTER, 'y'],
        ...['1', '.', '5', ENTER, ENTER, ENTER, '3', ENTER],
      ])
      const path = await runSharpenNew(envWith(terminal), {})
      expect(path.endsWith('web-crisp.json')).toBe(true)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        for: 'glossy',
        amount: 'high',
        radius: 1.5,
        threshold: 3,
      })
    })

    it('asks again when a fine setting is out of range', async () => {
      const terminal = fakeTerminal([
        ...[ENTER, ENTER, ENTER, ENTER, 'y'],
        ...['5', '0', ENTER, '2', ENTER, ENTER, ENTER, ENTER],
      ])
      const path = await runSharpenNew(envWith(terminal), {})
      expect(JSON.parse(readFileSync(path, 'utf8')).radius).toBe(2)
      expect(logged.join('\n')).toContain('radius: expected a number from 0.000001 to 10')
    })

    it('init offers the saved presets after the three targets', async () => {
      writePreset('crisp', { for: 'screen', radius: 0.8 })
      const terminal = fakeTerminal([
        ...[ENTER, ENTER, ENTER, ENTER, ENTER, DOWN, DOWN, ENTER, ENTER],
        ...[DOWN, DOWN, DOWN, DOWN, ENTER, 'n', 'n'],
      ])
      const path = await runInit(envWith(terminal), {})
      expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].sharpen).toBe('crisp')
    })

    it('the manager edits a preset with the same questions', async () => {
      writePreset('crisp', { for: 'screen', description: 'web' })
      const terminal = fakeTerminal([...[ENTER, DOWN, ENTER, DOWN, ENTER, DOWN, ENTER, 'n'], 'q'])
      await manageSharpenPresets(envWith(terminal))
      expect(JSON.parse(readFileSync(join(presetDir(), 'crisp.json'), 'utf8'))).toEqual({
        description: 'web',
        for: 'matte',
        amount: 'standard',
      })
    })

    it('the manager deletes a preset but keeps a .bak copy', async () => {
      writePreset('crisp', { for: 'screen' })
      const terminal = fakeTerminal([ENTER, DOWN, DOWN, DOWN, ENTER, 'y', 'q'])
      await manageSharpenPresets(envWith(terminal))
      expect(existsSync(join(presetDir(), 'crisp.json'))).toBe(false)
      expect(existsSync(join(presetDir(), 'crisp.json.bak'))).toBe(true)
    })

    it('the manager offers only show and copy for a built-in preset', async () => {
      const terminal = fakeTerminal([ENTER, DOWN, ENTER, 'q'])
      await manageSharpenPresets(envWith(terminal))
      const copy = join(presetDir(), 'web-light.json')
      expect(JSON.parse(readFileSync(copy, 'utf8'))).toMatchObject({ for: 'screen', amount: 'low' })
      expect(terminal.written).not.toContain('Delete')
      expect(terminal.written).not.toContain('Edit')
    })

    it('the manager copies a project preset to the global folder', async () => {
      writePreset('crisp', { for: 'screen' })
      const terminal = fakeTerminal([ENTER, DOWN, DOWN, ENTER, 'q'])
      await manageSharpenPresets(envWith(terminal))
      const copy = join(root, 'home', '.mediatoolz', 'image-batch', 'sharpen', 'crisp.json')
      expect(JSON.parse(readFileSync(copy, 'utf8'))).toEqual({ for: 'screen' })
    })
  })

  it('init offers the formats as a checklist with the usual three ticked', async () => {
    const terminal = fakeTerminal([
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ENTER,
      'n',
      'n',
    ])
    const path = await runInit(envWith(terminal), {})
    expect(terminal.written).toContain('Which formats should the config produce?')
    for (const name of ['avif', 'webp', 'jpg', 'png', 'gif', 'tiff', 'heif', 'original']) {
      expect(terminal.written).toContain(name)
    }
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].formats).toEqual([
      'avif',
      'webp',
      'jpg',
    ])
  })

  it('init takes the formats that were ticked', async () => {
    const terminal = fakeTerminal([
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      'n',
      DOWN,
      SPACE,
      SPACE,
      SPACE,
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ENTER,
      'n',
      'n',
    ])
    const path = await runInit(envWith(terminal), {})
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].formats).toEqual([
      'webp',
      'jpg',
      'png',
    ])
  })

  it('init asks again when no format is ticked', async () => {
    const terminal = fakeTerminal([
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      'n',
      ENTER,
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ENTER,
      'n',
      'n',
    ])
    const path = await runInit(envWith(terminal), {})
    expect(logged.join(' ')).toContain('Pick at least one format.')
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].formats).toEqual([
      'avif',
      'webp',
      'jpg',
    ])
  })

  it('init stops when the format list is cancelled', async () => {
    await expect(
      runInit(envWith(fakeTerminal([ENTER, ENTER, ENTER, ENTER, 'q'])), {}),
    ).rejects.toThrow(/cancelled/)
  })

  it('init asks for the file name template and keeps the default when left as it is', async () => {
    const terminal = fakeTerminal([
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ENTER,
      'n',
      'n',
    ])
    const path = await runInit(envWith(terminal), {})
    expect(terminal.written).toContain('File name template')
    expect(terminal.written).toContain('{dir}/{name}-{width}w.{format}')
    expect(logged.join(' ')).toContain('Variables:')
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].name).toBeUndefined()
  })

  it('init stores a file name template that was typed', async () => {
    const typed = [...'{name}@{width}.{format}']
    const erase = [...'{dir}/{name}-{width}w.{format}'].map(() => String.fromCharCode(127))
    const terminal = fakeTerminal([
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ...erase,
      ...typed,
      ENTER,
      ENTER,
      'n',
      'n',
    ])
    const path = await runInit(envWith(terminal), {})
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].name).toBe('{name}@{width}.{format}')
  })

  it('init takes the file name template from a flag and rejects a bad one', async () => {
    const path = await runInit(env, { name: 'flagged', fileName: '{dir}/{name}.{hash:6}.{format}' })
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].name).toBe(
      '{dir}/{name}.{hash:6}.{format}',
    )
    await expect(runInit(env, { name: 'bad', fileName: '{nope}.{format}' })).rejects.toThrow(
      /unknown variable/,
    )
  })

  const afterSize = [ENTER, DOWN, DOWN, ENTER, ENTER, ENTER, 'n', 'n']

  it('init lets you choose how the size is given, width first', async () => {
    const terminal = fakeTerminal([
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ENTER,
      'n',
      'n',
    ])
    const path = await runInit(envWith(terminal), {})
    expect(terminal.written).toContain('How should the size be chosen?')
    for (const label of [
      'Width',
      'Height',
      'Box (width × height)',
      'Long side',
      'Short side',
      'Megapixels',
      'Percentage',
      'Original size',
    ]) {
      expect(terminal.written).toContain(label)
    }
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].widths).toEqual([400, 800, 1200])
  })

  it('init takes the long side', async () => {
    const terminal = fakeTerminal([
      ENTER,
      ENTER,
      DOWN,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ENTER,
      ...afterSize,
    ])
    const path = await runInit(envWith(terminal), {})
    const recipe = JSON.parse(readFileSync(path, 'utf8')).outputs[0]
    expect(recipe.longEdge).toEqual([1600])
    expect(recipe.widths).toBeUndefined()
  })

  it('init takes the short side, megapixels and percentage with their suggested values', async () => {
    const run = async (downs: number) => {
      const keys = [ENTER, ENTER, ...Array(downs).fill(DOWN), ENTER, ENTER, ENTER, ...afterSize]
      return JSON.parse(
        readFileSync(await runInit(envWith(fakeTerminal(keys)), { force: true }), 'utf8'),
      ).outputs[0]
    }
    expect((await run(4)).shortEdge).toEqual([1080])
    expect((await run(5)).megapixels).toEqual([2, 0.5])
    expect((await run(6)).percent).toEqual([50, 25])
  })

  it('init takes a box with a fit and the orientation turned around', async () => {
    const keys = [ENTER, ENTER, DOWN, DOWN, ENTER, ENTER, DOWN, ENTER, 'y', ENTER, ...afterSize]
    const path = await runInit(envWith(fakeTerminal(keys)), {})
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0]).toMatchObject({
      size: '1920x1080',
      fit: 'cover',
      matchOrientation: true,
    })
  })

  it('init keeps the original size when asked', async () => {
    const keys = [ENTER, ENTER, ...Array(7).fill(DOWN), ENTER, ENTER, ...afterSize]
    const path = await runInit(envWith(fakeTerminal(keys)), {})
    const recipe = JSON.parse(readFileSync(path, 'utf8')).outputs[0]
    for (const key of [
      'widths',
      'heights',
      'size',
      'longEdge',
      'shortEdge',
      'megapixels',
      'percent',
    ]) {
      expect(recipe[key]).toBeUndefined()
    }
  })

  it('init takes any size method from flags', async () => {
    const path = await runInit(env, { name: 'f', sizeFields: { longEdge: [1200], percent: [50] } })
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0]).toMatchObject({
      longEdge: [1200],
      percent: [50],
    })
    await expect(runInit(env, { name: 'g', sizeFields: { longEdge: [0] } })).rejects.toThrow(
      /whole numbers/,
    )
  })

  it('the recipe editor switches the size method and drops the old one', async () => {
    const path = writeConfig('web', {
      outputs: [{ id: 'main', widths: [100, 200], formats: ['png'] }],
    })
    const keys = [
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ENTER,
      DOWN,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      'q',
      'q',
      'q',
    ]
    await manageConfigs(envWith(fakeTerminal(keys)))
    const recipe = JSON.parse(readFileSync(path, 'utf8')).outputs[0]
    expect(recipe.longEdge).toEqual([1600])
    expect(recipe.widths).toBeUndefined()
    expect(recipe.formats).toEqual(['png'])
  })

  it('the recipe editor starts the values from the current ones', async () => {
    const path = writeConfig('web', { outputs: [{ id: 'main', widths: [100, 200] }] })
    const keys = [ENTER, DOWN, DOWN, ENTER, ENTER, ENTER, ENTER, ENTER, 'q', 'q', 'q']
    const terminal = fakeTerminal(keys)
    await manageConfigs(envWith(terminal))
    expect(terminal.written).toContain('100,200')
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].widths).toEqual([100, 200])
  })

  it('adding a recipe asks for its size method first', async () => {
    const path = writeConfig('web', { outputs: [{ id: 'main', widths: [100] }] })
    const keys = [
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      DOWN,
      ENTER,
      DOWN,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      'q',
      'q',
      'q',
    ]
    await manageConfigs(envWith(fakeTerminal(keys)))
    const saved = JSON.parse(readFileSync(path, 'utf8')).outputs
    expect(saved).toHaveLength(2)
    expect(saved[1]).toMatchObject({ formats: ['webp'], longEdge: [1600] })
  })

  it('lists configs in a table with their scope and counts', async () => {
    writeConfig('web', { outputs: [{}, {}], match: [{ glob: 'a/**', outputs: [{}] }] })
    writeConfig('avatars', { outputs: [{ size: '64x64' }] }, 'global')
    writeFileSync(join(root, 'proj', '.mediatoolz', 'image-batch', 'broken.json'), '{ nope')
    const rows = await listConfigRows(env)
    expect(
      rows.map(
        (row) =>
          `${row.location.scope}:${row.location.name}:${row.recipes}:${row.rules}:${row.error ? 'err' : 'ok'}`,
      ),
    ).toEqual(['project:broken:0:0:err', 'project:web:2:1:ok', 'global:avatars:1:0:ok'])
    const table = renderConfigTable(rows, { plain: true }).join('\n')
    expect(table).toContain('web')
    expect(table).toContain('global')
    expect(table).toContain('error')
  })

  it('describes what a config produces', () => {
    const config = parseConfig({
      name: 'Web',
      description: 'for the site',
      presets: { r: { widths: [400, 800], formats: ['webp'] } },
      outputs: [{ id: 'main', preset: 'r' }],
      match: [{ glob: 'hero/**', outputs: [{ size: '100x100', fit: 'cover' }] }],
      placeholders: { hazehash: { budget: 20 } },
    })
    const text = describeConfigLines(config, { plain: true }).join('\n')
    expect(text).toContain('Web')
    expect(text).toContain('main')
    expect(text).toContain('widths 400, 800')
    expect(text).toContain('hero/**')
    expect(text).toContain('box 100×100')
    expect(text).toContain('hazehash')
    expect(text).toContain('{dir}/{name}-{width}w.{format}')
  })

  it('deleting keeps a .bak copy unless forced', () => {
    const path = writeConfig('web', { outputs: [{}] })
    const location = {
      name: 'web',
      path,
      scope: 'project' as const,
      kind: 'json' as const,
      editable: true,
    }
    const kept = removeConfigFile(location, false)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(kept)).toBe(true)
    const again = writeConfig('web', { outputs: [{}] })
    removeConfigFile({ ...location, path: again }, true)
    expect(existsSync(again)).toBe(false)
  })

  it('prints a plain table when not in a terminal', async () => {
    writeConfig('web', { outputs: [{}] })
    await manageConfigs(env)
    expect(logged.join('\n')).toContain('web')
  })

  it('says so when there is nothing yet', async () => {
    await manageConfigs(env)
    expect(logged.join('\n')).toContain('No configs found')
  })

  it('shows a config from the selector', async () => {
    writeConfig('web', { outputs: [{ id: 'main', widths: [100], formats: ['png'] }] })
    const terminal = fakeTerminal([ENTER, DOWN, ENTER, 'q', 'q'])
    await manageConfigs(envWith(terminal))
    expect(logged.join('\n')).toContain('main')
    expect(logged.join('\n')).toContain('widths 100')
  })

  it('deletes a config after confirmation', async () => {
    const path = writeConfig('web', { outputs: [{}] })
    const terminal = fakeTerminal([ENTER, ...Array(6).fill(DOWN), ENTER, 'y', 'q'])
    await manageConfigs(envWith(terminal))
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.bak`)).toBe(true)
  })

  it('does not delete when the answer is no', async () => {
    const path = writeConfig('web', { outputs: [{}] })
    const terminal = fakeTerminal([ENTER, ...Array(6).fill(DOWN), ENTER, 'n', 'q'])
    await manageConfigs(envWith(terminal))
    expect(existsSync(path)).toBe(true)
  })

  it('duplicates a config under a new name', async () => {
    const path = writeConfig('web', { outputs: [{}] })
    const terminal = fakeTerminal([ENTER, ...Array(3).fill(DOWN), ENTER, ENTER, 'q'])
    await manageConfigs(envWith(terminal))
    expect(existsSync(path.replace('web.json', 'web-copy.json'))).toBe(true)
  })

  it('renames a config', async () => {
    const path = writeConfig('web', { outputs: [{}] })
    const terminal = fakeTerminal([
      ENTER,
      ...Array(4).fill(DOWN),
      ENTER,
      ...'-old'.split(''),
      ENTER,
      'q',
    ])
    await manageConfigs(envWith(terminal))
    expect(existsSync(path)).toBe(false)
    expect(existsSync(path.replace('web.json', 'web-old.json'))).toBe(true)
  })

  it('copies a project config to the global folder', async () => {
    writeConfig('web', { outputs: [{}] })
    const terminal = fakeTerminal([ENTER, ...Array(5).fill(DOWN), ENTER, ENTER, 'q'])
    await manageConfigs(envWith(terminal))
    expect(existsSync(join(root, 'home', '.mediatoolz', 'image-batch', 'web.json'))).toBe(true)
  })

  it('edits a recipe field, saves valid JSON and keeps the indent', async () => {
    const path = writeConfig('web', { outputs: [{ id: 'main', widths: [100], formats: ['png'] }] })
    const terminal = fakeTerminal([
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ...Array(3).fill(DOWN),
      ENTER,
      ...'\x7f\x7f\x7f\x7f\x7f'.split(''),
      ...'200, 400'.split(''),
      ENTER,
      'q',
      'q',
      'q',
    ])
    await manageConfigs(envWith(terminal))
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.outputs[0].widths).toEqual([200, 400])
    expect(readFileSync(path, 'utf8')).toContain('\n  "outputs"')
  })

  it('refuses an invalid edit and keeps the old value', async () => {
    const path = writeConfig('web', { outputs: [{ id: 'main', widths: [100] }] })
    const terminal = fakeTerminal([
      ENTER,
      DOWN,
      DOWN,
      ENTER,
      ENTER,
      ...Array(3).fill(DOWN),
      ENTER,
      ...'\x7f\x7f\x7f'.split(''),
      ...'abc'.split(''),
      ENTER,
      'q',
      'q',
      'q',
    ])
    const managed = envWith(terminal)
    await manageConfigs(managed)
    expect(JSON.parse(readFileSync(path, 'utf8')).outputs[0].widths).toEqual([100])
  })
})
