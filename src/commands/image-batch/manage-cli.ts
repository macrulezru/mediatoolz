import { resolve } from 'node:path'
import type { Command } from 'commander'
import { createStyle } from '../../format/style.js'
import { defaultTerminal } from '../../utils/tty.js'
import { splitList } from '../../utils/split-list.js'
import { ImageBatchUsageError } from './errors.js'
import {
  listSharpenRows,
  manageSharpenPresets,
  removeSharpenPreset,
  renderSharpenTable,
  runSharpenNew,
  sharpenLocationFor,
  showSharpenPreset,
} from './sharpen-manage.js'
import { addSharpenFlags, parseSharpenFlags, type SharpenFlagOptions } from './sharpen.js'
import { renderRestoreReport, runRestore } from './restore.js'
import {
  configPathFor,
  listConfigRows,
  manageConfigs,
  removeConfigFile,
  renderConfigTable,
  runInit,
  showConfig,
  type ManageEnv,
} from './manage.js'

interface CommonOptions {
  cwd: string
  json?: boolean
  plain: boolean
  color: boolean
}

function envFrom(options: CommonOptions): ManageEnv {
  return {
    cwd: resolve(options.cwd),
    io: defaultTerminal(),
    style: { plain: options.plain, color: options.color },
    log: (text) => console.log(text),
  }
}

async function guarded(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (error instanceof ImageBatchUsageError) {
      console.error(`error: ${error.message}`)
      process.exitCode = 2
      return
    }
    throw error
  }
}

interface SizeFlags {
  widths?: string
  heights?: string
  size?: string
  long?: string
  short?: string
  megapixels?: string
  percent?: string
  fit?: string
  matchOrientation?: boolean
}

function sizeFields(options: SizeFlags): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {}
  const list = (value: string) => splitList(value).map(Number)
  if (options.widths) fields.widths = list(options.widths)
  if (options.heights) fields.heights = list(options.heights)
  if (options.size) fields.size = options.size
  if (options.long) fields.longEdge = list(options.long)
  if (options.short) fields.shortEdge = list(options.short)
  if (options.megapixels) fields.megapixels = list(options.megapixels)
  if (options.percent) fields.percent = list(options.percent)
  if (options.size && options.fit) fields.fit = options.fit
  if (options.size && options.matchOrientation) fields.matchOrientation = true
  return Object.keys(fields).length > 0 ? fields : undefined
}

type InitCliOptions = CommonOptions &
  SizeFlags &
  SharpenFlagOptions & {
    name?: string
    global?: boolean
    formats?: string
    quality?: string
    fileName?: string
    thumbnail?: boolean
    hazehash?: boolean
    force: boolean
  }

function addInitOptions(command: Command): Command {
  addSharpenFlags(command)
  return command
    .option('--cwd <path>', 'project folder the config is saved in', process.cwd())
    .option('--name <name>', 'name of the config (asked when omitted)')
    .option('--global', 'save it for all projects instead of this one')
    .option('-w, --widths <list>', 'size by width in pixels, comma-separated')
    .option('--heights <list>', 'size by height in pixels, comma-separated')
    .option('--size <WxH>', 'size by a box, e.g. 1920x1080 (see --fit, --match-orientation)')
    .option('--long <list>', 'size by the long side in pixels, comma-separated')
    .option('--short <list>', 'size by the short side in pixels, comma-separated')
    .option('--megapixels <list>', 'size by area in megapixels, comma-separated')
    .option('--percent <list>', 'size as a percentage of the source, comma-separated')
    .option('--fit <mode>', 'with --size: inside, cover, contain, outside or fill')
    .option('--match-orientation', 'with --size: turn the box around for the other orientation')
    .option('-f, --formats <list>', 'output formats, comma-separated')
    .option('-q, --quality <level>', 'quality: a number, low, medium, high or best')
    .option(
      '--file-name <template>',
      'file name template of the main recipe, e.g. {dir}/{name}-{width}w.{format} (default: chosen by the size method)',
    )
    .option('--thumbnail', 'add a 200x200 cropped thumbnail recipe')
    .option('--hazehash', 'compute a hazehash for the --emit manifest')
    .option('--force', 'replace a config of the same name', false)
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
}

async function initAction(options: InitCliOptions): Promise<void> {
  await guarded(async () => {
    const fields = sizeFields(options)
    const sharpen = parseSharpenFlags(options)
    await runInit(envFrom(options), {
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.global !== undefined ? { global: options.global } : {}),
      ...(fields ? { sizeFields: fields } : {}),
      ...(options.formats ? { formats: splitList(options.formats) } : {}),
      ...(options.quality ? { quality: options.quality } : {}),
      ...(options.fileName ? { fileName: options.fileName } : {}),
      ...(sharpen ? { sharpen } : {}),
      ...(options.thumbnail !== undefined ? { thumbnail: options.thumbnail } : {}),
      ...(options.hazehash !== undefined ? { hazehash: options.hazehash } : {}),
      force: options.force,
    })
  })
}

async function listAction(options: CommonOptions & { list?: boolean }): Promise<void> {
  await guarded(async () => {
    const env = envFrom(options)
    if (options.json) {
      const rows = await listConfigRows(env)
      console.log(
        JSON.stringify(
          rows.map((row) => ({
            name: row.location.name,
            scope: row.location.scope,
            path: row.location.path,
            kind: row.location.kind,
            title: row.title,
            recipes: row.recipes,
            rules: row.rules,
            error: row.error,
          })),
          null,
          2,
        ),
      )
      return
    }
    if (options.list) {
      const rows = await listConfigRows(env)
      const s = createStyle(env.style)
      console.log(
        rows.length === 0
          ? s.warn('No configs found — create one with `mediatoolz image-batch init`.')
          : renderConfigTable(rows, env.style).join('\n'),
      )
      return
    }
    await manageConfigs(env)
  })
}

export function registerImageBatchManagement(parent: Command): void {
  addInitOptions(
    parent
      .command('init')
      .description('Create a config (a reusable set of rules) with a short wizard'),
  ).action(initAction)

  const config = parent
    .command('config')
    .description(
      'Manage the saved configs: in a terminal pick one to apply, show, edit, copy or delete (subcommands: new, list, show, rm)',
    )
    .option('--cwd <path>', 'project folder the configs are looked up from', process.cwd())
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (options: CommonOptions) => listAction({ ...options }))

  addInitOptions(
    config.command('new').description('Create a config with a short wizard (same as init)'),
  ).action(initAction)

  config
    .command('list')
    .description('Print a table of the saved configs')
    .option('--cwd <path>', 'project folder the configs are looked up from', process.cwd())
    .option('--json', 'machine-readable output', false)
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (options: CommonOptions) => listAction({ ...options, list: true }))

  config
    .command('show')
    .argument('<name>', 'config name')
    .description('Print what a config produces')
    .option('--cwd <path>', 'project folder the configs are looked up from', process.cwd())
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (name: string, options: CommonOptions) =>
      guarded(async () => {
        const env = envFrom(options)
        await showConfig(env, configPathFor(env, name))
      }),
    )

  config
    .command('rm')
    .argument('<name>', 'config name')
    .description('Delete a config (a .bak copy is kept unless --force)')
    .option('--cwd <path>', 'project folder the configs are looked up from', process.cwd())
    .option('-y, --yes', 'do not ask for confirmation', false)
    .option('--force', 'delete for good, without a .bak copy', false)
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (name: string, options: CommonOptions & { yes: boolean; force: boolean }) =>
      guarded(async () => {
        const env = envFrom(options)
        const location = configPathFor(env, name)
        if (!options.yes) {
          throw new ImageBatchUsageError(`this deletes ${location.path} — pass --yes to confirm`)
        }
        const kept = removeConfigFile(location, options.force)
        console.log(
          options.force ? `Deleted ${location.path}` : `Deleted ${location.path} (backup: ${kept})`,
        )
      }),
    )

  const sharpen = parent
    .command('sharpen')
    .description(
      'Manage saved sharpening presets that configs and runs can use: in a terminal pick one to show, edit, copy or delete (subcommands: new, list, show, rm)',
    )
    .option('--cwd <path>', 'project folder the presets are looked up from', process.cwd())
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (options: CommonOptions) =>
      guarded(async () => manageSharpenPresets(envFrom(options))),
    )

  addSharpenFlags(
    sharpen
      .command('new')
      .description('Create a sharpening preset (a short wizard, or the flags below)')
      .option('--cwd <path>', 'project folder the preset is saved in', process.cwd())
      .option('--name <name>', 'name of the preset (asked when omitted)')
      .option('--global', 'save it for all projects instead of this one')
      .option('--description <text>', 'a note shown in the list')
      .option('--force', 'replace a preset of the same name', false)
      .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
      .option('--color', 'force colored output even when piped or in CI', false),
    false,
  ).action(
    async (
      options: CommonOptions &
        SharpenFlagOptions & {
          name?: string
          global?: boolean
          description?: string
          force: boolean
        },
    ) =>
      guarded(async () => {
        const fields = parseSharpenFlags(options)
        await runSharpenNew(envFrom(options), {
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.global !== undefined ? { global: options.global } : {}),
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(fields ? { fields } : {}),
          force: options.force,
        })
      }),
  )

  sharpen
    .command('list')
    .description('Print a table of the saved sharpening presets')
    .option('--cwd <path>', 'project folder the presets are looked up from', process.cwd())
    .option('--json', 'machine-readable output', false)
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (options: CommonOptions) =>
      guarded(async () => {
        const env = envFrom(options)
        const rows = listSharpenRows(env)
        if (options.json) {
          console.log(
            JSON.stringify(
              rows.map((row) => ({
                name: row.location.name,
                scope: row.location.scope,
                path: row.location.path,
                description: row.description,
                ...(row.fields ?? {}),
                error: row.error,
              })),
              null,
              2,
            ),
          )
          return
        }
        const style = createStyle(env.style)
        console.log(
          rows.length === 0
            ? style.warn(
                'No sharpen presets found — create one with `mediatoolz image-batch sharpen new`.',
              )
            : renderSharpenTable(rows, env.style).join('\n'),
        )
      }),
    )

  sharpen
    .command('show')
    .argument('<name>', 'preset name')
    .description('Print the settings of a preset and the values sharp receives')
    .option('--cwd <path>', 'project folder the presets are looked up from', process.cwd())
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (name: string, options: CommonOptions) =>
      guarded(async () => showSharpenPreset(envFrom(options), name)),
    )

  sharpen
    .command('rm')
    .argument('<name>', 'preset name')
    .description('Delete a preset (a .bak copy is kept unless --force)')
    .option('--cwd <path>', 'project folder the presets are looked up from', process.cwd())
    .option('-y, --yes', 'do not ask for confirmation', false)
    .option('--force', 'delete for good, without a .bak copy', false)
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (name: string, options: CommonOptions & { yes: boolean; force: boolean }) =>
      guarded(async () => {
        const location = sharpenLocationFor(envFrom(options), name)
        if (!options.yes) {
          throw new ImageBatchUsageError(`this deletes ${location.path} — pass --yes to confirm`)
        }
        const kept = removeSharpenPreset(location, options.force)
        console.log(
          options.force ? `Deleted ${location.path}` : `Deleted ${location.path} (backup: ${kept})`,
        )
      }),
    )

  parent
    .command('restore')
    .argument('<dir>', 'the dated backup folder that --replace created')
    .description(
      'Put back the original files that --replace saved, using the journal in that folder',
    )
    .option('--cwd <path>', 'folder a relative <dir> is resolved against', process.cwd())
    .option('--dry-run', 'show what would be restored, write nothing', false)
    .option('--force', 'also restore files that changed after they were replaced', false)
    .option('-y, --yes', 'restore without asking', false)
    .option('--json', 'machine-readable output', false)
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(
      async (
        dir: string,
        options: CommonOptions & { dryRun: boolean; force: boolean; yes: boolean },
      ) =>
        guarded(async () => {
          const style = { plain: options.plain, color: options.color }
          const report = await runRestore({
            dir,
            cwd: resolve(options.cwd),
            dryRun: options.dryRun,
            force: options.force,
            assumeYes: options.yes,
            interactive:
              Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY) && !options.json,
            style,
          })
          console.log(
            options.json ? JSON.stringify(report, null, 2) : renderRestoreReport(report, style),
          )
          process.exitCode = report.exitCode
        }),
    )
}
