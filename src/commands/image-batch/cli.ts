import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { createStyle } from '../../format/style.js'
import { askText, defaultTerminal, isInteractive, singleSelect } from '../../utils/tty.js'
import { splitList } from '../../utils/split-list.js'
import {
  MAX_HAZEHASH_BUDGET,
  MIN_HAZEHASH_BUDGET,
  parseBudget,
  parseExtensions,
  parseFileList,
  parseMaxPixels,
  type HashType,
} from '../image-hash/core.js'
import { parseCodecArgs, parseQualityArg } from './codecs.js'
import {
  discoverConfigs,
  emptyConfig,
  loadConfig,
  parseByteSize,
  resolveConfigRef,
  type BatchConfig,
  type ConfigLocation,
  type PlaceholderSettings,
} from './config.js'
import { ImageBatchUsageError } from './errors.js'
import { FIT_MODES, type Fit } from './geometry.js'
import { BATCH_IMAGE_EXTENSIONS } from './inputs.js'
import { registerImageBatchManagement } from './manage-cli.js'
import type { OverwriteMode } from './overwrite.js'
import { addSharpenFlags, parseSharpenFlags, type SharpenFlagOptions } from './sharpen.js'
import { renderImageBatchReport } from './report.js'
import { runImageBatch, type BatchOverrides } from './run.js'

interface ImageBatchCliOptions extends SharpenFlagOptions {
  cwd: string
  config?: string
  out?: string
  beside: boolean
  replace: boolean
  backup?: string | boolean
  onlyIfSmaller: boolean
  recursive: boolean
  filesFrom?: string
  ext: string
  ignore: string[]
  respectGitignore: boolean
  include: string[]
  exclude: string[]
  widths?: string
  heights?: string
  long?: string
  short?: string
  megapixels?: string
  percent?: string
  matchOrientation: boolean
  resize: boolean
  maxSize?: string
  formats?: string
  quality?: string
  codec: string[]
  fit?: string
  name?: string
  flatten?: boolean | string
  flat: boolean
  hazehash: boolean
  blurhash: boolean
  thumbhash: boolean
  dominantColor: boolean
  budget?: string
  emit?: string
  keyPrefix?: string
  select: boolean
  list: boolean
  overwrite?: boolean
  skipExisting: boolean
  force: boolean
  cache?: string | boolean
  concurrency: string
  maxPixels?: string
  dryRun: boolean
  yes: boolean
  json: boolean
  quiet: boolean
  verbose: boolean
  plain: boolean
  color: boolean
}

function parseNumberList(value: string, flag: string): number[] {
  const numbers = splitList(value).map(Number)
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > 65535)) {
    throw new ImageBatchUsageError(
      `${flag} must be whole numbers from 1 to 65535, e.g. 400,800,1200`,
    )
  }
  return numbers
}

function parseDecimalList(value: string, flag: string, min: number, max: number): number[] {
  const numbers = splitList(value).map(Number)
  if (numbers.length === 0 || numbers.some((n) => !Number.isFinite(n) || n < min || n > max)) {
    throw new ImageBatchUsageError(`${flag} must be numbers from ${min} to ${max}, e.g. 2,0.5`)
  }
  return numbers
}

function overridesFrom(options: ImageBatchCliOptions): BatchOverrides | undefined {
  const overrides: BatchOverrides = {}
  if (!options.resize) {
    const conflicting = [
      ['--widths', options.widths],
      ['--heights', options.heights],
      ['--long', options.long],
      ['--short', options.short],
      ['--megapixels', options.megapixels],
      ['--percent', options.percent],
      ['--match-orientation', options.matchOrientation],
    ].filter(([, value]) => value)
    if (conflicting.length > 0) {
      throw new ImageBatchUsageError(
        `--no-resize keeps the original size, so it cannot be combined with ${conflicting.map(([flag]) => flag).join(', ')}`,
      )
    }
    overrides.noResize = true
  }
  if (options.widths) overrides.widths = parseNumberList(options.widths, '--widths')
  if (options.heights) overrides.heights = parseNumberList(options.heights, '--heights')
  if (options.long) overrides.longEdge = parseNumberList(options.long, '--long')
  if (options.short) overrides.shortEdge = parseNumberList(options.short, '--short')
  if (options.megapixels) {
    overrides.megapixels = parseDecimalList(options.megapixels, '--megapixels', 0.001, 1000)
  }
  if (options.percent) overrides.percent = parseDecimalList(options.percent, '--percent', 0.1, 1000)
  if (options.matchOrientation) overrides.matchOrientation = true
  if (options.maxSize) overrides.maxBytes = parseByteSize(options.maxSize, '--max-size')
  const sharpen = parseSharpenFlags(options)
  if (sharpen) overrides.sharpen = sharpen
  if (options.formats) overrides.formats = splitList(options.formats)
  if (options.quality) overrides.quality = parseQualityArg(options.quality)
  if (options.codec.length > 0) overrides.codecs = parseCodecArgs(options.codec)
  if (options.fit) {
    if (!(FIT_MODES as readonly string[]).includes(options.fit)) {
      throw new ImageBatchUsageError(`--fit must be one of ${FIT_MODES.join(', ')}`)
    }
    overrides.fit = options.fit as Fit
  }
  if (options.name) overrides.name = options.name
  if (options.flatten !== undefined) overrides.flatten = options.flatten
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

function placeholdersFrom(options: ImageBatchCliOptions): PlaceholderSettings | undefined {
  const types: HashType[] = []
  if (options.hazehash) types.push('hazehash')
  if (options.blurhash) types.push('blurhash')
  if (options.thumbhash) types.push('thumbhash')
  if (options.dominantColor) types.push('color')
  if (types.length === 0) {
    if (options.budget !== undefined) {
      throw new ImageBatchUsageError(
        `--budget is the size of a hazehash (${MIN_HAZEHASH_BUDGET}–${MAX_HAZEHASH_BUDGET} bytes) — add --hazehash`,
      )
    }
    return undefined
  }
  const settings: PlaceholderSettings = { types }
  if (options.budget !== undefined) settings.budget = parseBudget(options.budget)
  return settings
}

function overwriteMode(options: ImageBatchCliOptions): OverwriteMode | undefined {
  if (options.overwrite === true) return 'overwrite'
  if (options.overwrite === false) return 'error'
  if (options.skipExisting) return 'skip'
  return undefined
}

export async function chooseConfig(
  options: { config?: string; cwd: string; adHoc: boolean; interactive: boolean },
  style: { plain?: boolean; color?: boolean },
): Promise<{ config: BatchConfig; label?: string }> {
  const discovered = discoverConfigs({ cwd: options.cwd })
  let location: ConfigLocation | undefined
  if (options.config !== undefined) {
    location = resolveConfigRef(options.config, discovered, options.cwd)
  } else if (!options.adHoc && discovered.length === 1) {
    location = discovered[0]
  } else if (!options.adHoc && discovered.length > 1) {
    if (!options.interactive) {
      throw new ImageBatchUsageError(
        `several configs found — pick one with -c <name>: ${discovered.map((c) => c.name).join(', ')}`,
      )
    }
    const s = createStyle(style)
    const picked = await singleSelect(
      defaultTerminal(),
      discovered.map((candidate) => ({
        label: candidate.name,
        hint: `${candidate.scope} · ${candidate.path}`,
        value: candidate,
      })),
      { title: 'Which config should be applied?', help: 'enter pick · q cancel' },
      s,
    )
    if (picked === null) throw new ImageBatchUsageError('no config chosen')
    location = picked
  }
  if (!location) return { config: emptyConfig() }
  const { config } = await loadConfig(location)
  return { config, label: location.name }
}

export function registerImageBatch(program: Command): void {
  const command = program
    .command('image-batch')
    .description(
      'Batch-resize and convert raster images by rules: sizes, formats, codec options and file names from a config or flags (subcommands: init, config, sharpen, restore)',
    )
    .argument('[paths...]', 'image files, folders and globs to process (several allowed)', [])
    .option('--cwd <path>', 'root paths are resolved against', process.cwd())
    .option(
      '-c, --config <name|file>',
      'rules to apply: a saved config name or a path to a config file',
    )
    .option(
      '-o, --out <dir>',
      'folder the results go to (or use --beside / --replace); the sources are never touched',
    )
    .option(
      '--beside',
      'write the results next to each source, in the same folder (sources are not touched)',
      false,
    )
    .option(
      '--replace',
      'rewrite each source file in place, in its own format (originals are backed up first)',
      false,
    )
    .option(
      '--backup [dir]',
      'with --replace: where the originals are saved first (default: .image-batch-backup/<date>)',
    )
    .option('--no-backup', 'with --replace: do not keep a copy of the originals')
    .option(
      '--no-only-if-smaller',
      'with --replace: also replace files when the result is not smaller',
    )
    .option('-r, --recursive', 'also walk subdirectories of every given folder', false)
    .option(
      '--files-from <file>',
      'read more paths from a file, one per line (- = stdin, # starts a comment)',
    )
    .option(
      '--ext <list>',
      'comma-separated image extensions to pick up from folders',
      BATCH_IMAGE_EXTENSIONS.join(','),
    )
    .option(
      '--ignore <glob>',
      'extra ignore pattern (repeatable), on top of the built-in defaults',
      (val, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--no-respect-gitignore', "don't also honor the project's .gitignore")
    .option(
      '--include <glob>',
      'only process images whose path (inside the given folder) matches (repeatable)',
      (val, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--exclude <glob>',
      'skip images whose path (inside the given folder) matches (repeatable)',
      (val, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option(
      '--no-resize',
      'keep the original size: ignore every size set in the config and only convert the format',
    )
    .option('-w, --widths <list>', 'output widths in pixels, comma-separated, e.g. 400,800,1200')
    .option('--heights <list>', 'output heights in pixels, comma-separated')
    .option(
      '--long <list>',
      'size by the long side in pixels, comma-separated, whatever the orientation',
    )
    .option('--short <list>', 'size by the short side in pixels, comma-separated')
    .option('--megapixels <list>', 'size by area in megapixels, comma-separated, e.g. 2,0.5')
    .option('--percent <list>', 'size as a percentage of the source, comma-separated, e.g. 50,25')
    .option(
      '--match-orientation',
      'turn a width x height box around for images of the other orientation',
      false,
    )
    .option(
      '--max-size <size>',
      'limit each file to this size, e.g. 200KB or 1.5MB, by lowering the quality as far as needed',
    )
    .option(
      '-f, --formats <list>',
      'output formats: jpg, png, webp, avif, gif, tiff, jp2, heif or original',
    )
    .option(
      '-q, --quality <n|level|fmt=n,…>',
      'quality: 82, a level (low, medium, high, best) or per format, e.g. jpg=82,webp=high',
    )
    .option(
      '--codec <fmt.option=value>',
      'one codec option, e.g. jpg.mozjpeg=true or png.colors=64 (repeatable)',
      (val, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--fit <mode>', `how the image fills the target box: ${FIT_MODES.join(', ')}`)
    .option(
      '--name <template>',
      'output file name template: {name} {ext} {format} {dir} {width} {height} {size} {scale} {index} {hash} {date} {orig}',
    )
    .option(
      '--flatten [color]',
      'put images with transparency on a solid background (white unless a color is given)',
    )
    .option(
      '--flat',
      'put every result into the output folder itself, without the source subfolders',
      false,
    )
    .option('--hazehash', 'also compute a hazehash of every source (written to --emit)', false)
    .option('--blurhash', 'also compute a blurhash of every source (written to --emit)', false)
    .option('--thumbhash', 'also compute a thumbhash of every source (written to --emit)', false)
    .option(
      '--dominant-color',
      'also compute the dominant color of every source (written to --emit)',
      false,
    )
    .option(
      '--budget <bytes>',
      `hazehash: size of one hash in bytes, ${MIN_HAZEHASH_BUDGET}-${MAX_HAZEHASH_BUDGET} (default 28)`,
    )
    .option('--emit <file>', 'write a JSON manifest of everything that was produced')
    .option(
      '--key-prefix <text>',
      'text put in front of every path in the manifest placeholders, e.g. /images/',
    )
    .option('-i, --select', 'pick the images from an interactive list before processing', false)
    .option('--list', 'only print the images that would be processed', false)
    .option(
      '--overwrite',
      'replace existing output files that this command did not make or that are out of date',
    )
    .option('--no-overwrite', 'fail (exit 1) when an output file already exists')
    .option('--skip-existing', 'leave existing output files alone without failing', false)
    .option('--force', 'regenerate everything, ignoring what an earlier run already made', false)
    .option(
      '--cache [file]',
      'where the record of what was already made is kept (default: ~/.mediatoolz/cache/image-batch)',
    )
    .option('--no-cache', 'do not keep or use that record')
    .option('--concurrency <n>', 'images processed in parallel', '4')
    .option(
      '--max-pixels <n>',
      'refuse images with more pixels than this (0 = no limit; default: sharp limit, ~268 million)',
    )
    .option('--dry-run', 'write nothing — show what would be done', false)
    .option(
      '-y, --yes',
      'agree without asking: install the missing "sharp" library, confirm --replace',
      false,
    )
    .option('--json', 'machine-readable output', false)
    .option('--quiet', 'suppress output when there is nothing to report', false)
    .option('--verbose', 'list every produced file, not only problems', false)
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)

  addSharpenFlags(command)
  command.action(async (paths: string[], options: ImageBatchCliOptions) => {
    const style = { plain: options.plain, color: options.color }
    const io = defaultTerminal()
    const interactive = isInteractive(io) && !options.json
    const s = createStyle(style)
    const showProgress =
      !options.json && !options.quiet && Boolean(process.stderr.isTTY) && !options.plain
    let progressShown = false
    try {
      const cwd = resolve(options.cwd)
      const listed =
        options.filesFrom !== undefined
          ? parseFileList(readFileSync(options.filesFrom === '-' ? 0 : options.filesFrom, 'utf8'))
          : []
      const overrides = overridesFrom(options)
      const adHoc = overrides !== undefined
      const { config, label } = await chooseConfig(
        {
          cwd,
          adHoc,
          interactive,
          ...(options.config !== undefined ? { config: options.config } : {}),
        },
        style,
      )

      let out = options.out
      if (
        out === undefined &&
        !options.beside &&
        !options.replace &&
        interactive &&
        !options.list
      ) {
        const answer = await askText(io, 'Where should the results go? (output folder)', s)
        if (answer === null || answer.trim() === '') {
          throw new ImageBatchUsageError('no output folder given')
        }
        out = answer.trim()
      }

      const mode = overwriteMode(options)
      const placeholders = placeholdersFrom(options)
      const report = await runImageBatch({
        paths: [...paths, ...listed],
        cwd,
        ...(out !== undefined ? { out } : {}),
        beside: options.beside,
        replace: options.replace,
        ...(options.backup === false
          ? { backup: false as const }
          : typeof options.backup === 'string'
            ? { backup: options.backup }
            : {}),
        ...(options.onlyIfSmaller === false ? { onlyIfSmaller: false } : {}),
        config,
        ...(label !== undefined ? { configLabel: label } : {}),
        ...(overrides ? { overrides } : {}),
        recursive: options.recursive,
        extensions: parseExtensions(options.ext),
        ignoreGlobs: options.ignore,
        respectGitignore: options.respectGitignore,
        include: options.include,
        exclude: options.exclude,
        flat: options.flat,
        list: options.list,
        select: options.select,
        ...(mode ? { overwrite: mode } : {}),
        force: options.force,
        ...(placeholders ? { placeholders } : {}),
        ...(options.emit !== undefined ? { emit: options.emit } : {}),
        ...(options.keyPrefix !== undefined ? { keyPrefix: options.keyPrefix } : {}),
        ...(options.cache === false
          ? { cache: false as const }
          : typeof options.cache === 'string'
            ? { cache: options.cache }
            : {}),
        concurrency: Math.max(1, Number.parseInt(options.concurrency, 10) || 4),
        ...(options.maxPixels !== undefined
          ? { maxPixels: parseMaxPixels(options.maxPixels) }
          : {}),
        dryRun: options.dryRun,
        assumeYes: options.yes,
        interactive,
        io,
        style,
        ...(showProgress
          ? {
              onProgress: ({ done, total }: { done: number; total: number }) => {
                if (total < 2) return
                progressShown = true
                process.stderr.write(`\r${s.info(`Processing ${done}/${total}`)}`)
              },
            }
          : {}),
      })
      if (progressShown) process.stderr.write('\r\x1b[K')

      if (options.json) {
        const { ...printable } = report
        console.log(JSON.stringify(printable, null, 2))
      } else {
        const text = renderImageBatchReport(report, {
          ...style,
          quiet: options.quiet,
          verbose: options.verbose,
        })
        if (text) console.log(text)
      }
      process.exitCode = report.exitCode
    } catch (error) {
      if (progressShown) process.stderr.write('\r\x1b[K')
      if (error instanceof ImageBatchUsageError) {
        console.error(`error: ${error.message}`)
        process.exitCode = 2
        return
      }
      throw error
    }
  })

  command.enablePositionalOptions()
  registerImageBatchManagement(command)
}
