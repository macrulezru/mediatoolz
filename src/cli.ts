#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runImageHash } from './commands/image-hash/run.js'
import { renderImageHashReport } from './commands/image-hash/report.js'
import {
  DEFAULT_CACHE_FILE,
  DEFAULT_HAZEHASH_BUDGET,
  DEFAULT_IMAGE_EXTENSIONS,
  ImageHashUsageError,
  MAX_HAZEHASH_BUDGET,
  MIN_HAZEHASH_BUDGET,
  OUTPUT_FORMATS,
  parseBudget,
  parseComponents,
  parseExtensions,
  parseFileList,
  parseFormat,
  parseMaxPixels,
  parseSampleSize,
  parseTypes,
} from './commands/image-hash/core.js'
import { registerImageBatch } from './commands/image-batch/cli.js'
import { registerUi } from './commands/ui/cli.js'
import { createStyle } from './format/style.js'

interface HelpRow {
  indent: number
  label: string
  desc: string
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (current && candidate.length > width) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * Commander's own one-line-per-command "Commands:" list puts a command's
 * own flags inline after its name (`image-hash [options]`) and leaves
 * their descriptions for a separate `<command> --help` run — fine for a
 * CLI with one or two flags per command, but it means the top-level
 * `--help` never actually shows what any flag does. This builds a
 * two-level list instead (command, then each of its own options indented
 * below it with its own description), used in place of commander's
 * default via `configureHelp({ visibleCommands: () => [] })` +
 * `addHelpText('after')` — same technique as lintsync's/polyrepo-cli's
 * own `formatCommandsHelp`.
 *
 * A flag present on EVERY command, with the exact same `flags` string and
 * description (not just the same name coincidentally meaning something
 * slightly different per command), is pulled out into a "Common options"
 * block instead of being repeated under each one. A flag shared by only
 * SOME commands stays listed under each of those commands directly —
 * tried hoisting those into their own labeled sub-group too, but it's
 * harder to keep in your head which commands a "Common options (a, b)"
 * block actually applies to than to just see the flag where it's used.
 * This only changes how the help text is RENDERED — every flag is still
 * fully declared on its own command for real parsing, so
 * `mediatoolz <command> --cwd x` keeps working exactly as before; nothing
 * here is a true commander-level global option.
 */
function formatCommandsHelp(commands: readonly Command[]): string {
  const real = commands.filter((cmd) => cmd.name() !== 'help')

  // Which commands (by name) share the exact same flags+description for
  // a given option, keyed on that pair so two different flags spelled
  // the same but described differently never get merged.
  const owners = new Map<string, { flags: string; desc: string; commandCount: number }>()
  for (const cmd of real) {
    for (const opt of cmd.options) {
      const key = `${opt.flags}\u0000${opt.description}`
      const entry = owners.get(key) ?? { flags: opt.flags, desc: opt.description, commandCount: 0 }
      entry.commandCount++
      owners.set(key, entry)
    }
  }

  const universalRows: HelpRow[] = []
  const hoistedKeys = new Set<string>()

  for (const [key, entry] of owners) {
    if (entry.commandCount !== real.length) continue // not on every command — stays with each one below
    universalRows.push({ indent: 1, label: entry.flags, desc: entry.desc })
    hoistedKeys.add(key)
  }

  const commandGroups: HelpRow[][] = real.map((cmd) => {
    const aliases = cmd.aliases()
    const label = aliases.length > 0 ? `${cmd.name()}, ${aliases.join(', ')}` : cmd.name()
    const ownRows = cmd.options
      .filter((opt) => !hoistedKeys.has(`${opt.flags}\u0000${opt.description}`))
      .map((opt): HelpRow => ({ indent: 1, label: opt.flags, desc: opt.description }))
    return [{ indent: 0, label, desc: cmd.description() }, ...ownRows]
  })

  const allRows = [universalRows, ...commandGroups].flat()
  const labelWidth = Math.max(...allRows.map((r) => r.indent * 4 + r.label.length))
  const totalWidth = (process.stdout.isTTY && process.stdout.columns) || 96
  const descWidth = Math.max(totalWidth - (2 + labelWidth + 2), 30)

  function renderRow(row: HelpRow, lines: string[]): void {
    const fullLabel = ' '.repeat(row.indent * 4) + row.label
    const [firstLine, ...restLines] = wrapText(row.desc, descWidth)
    lines.push(`  ${fullLabel.padEnd(labelWidth)}  ${firstLine ?? ''}`)
    for (const cont of restLines) {
      lines.push(`  ${' '.repeat(labelWidth)}  ${cont}`)
    }
  }

  const lines: string[] = []
  if (universalRows.length > 0) {
    lines.push('Common options (all commands):')
    for (const row of universalRows) renderRow(row, lines)
    lines.push('')
  }

  lines.push('Commands:')
  commandGroups.forEach((group, i) => {
    if (i > 0) lines.push('')
    for (const row of group) renderRow(row, lines)
  })
  return lines.join('\n')
}

const program = new Command()
program.enablePositionalOptions()

program
  .name('mediatoolz')
  .description(
    'A small toolbox of CLI commands for images: resize, convert and recompress them in bulk, and generate placeholders',
  )
  // Hide commander's own one-line-per-command list (see formatCommandsHelp
  // above for why) — the "after" text below replaces it with the
  // two-level version instead of showing both.
  .configureHelp({ visibleCommands: () => [] })
  .addHelpText('after', () => `\n${formatCommandsHelp(program.commands)}`)

program
  .command('image-hash')
  .description(
    'Generate hazehash/blurhash/thumbhash placeholders (and dominant color, tiny preview) for raster images — to stdout, one file, or a file per image',
  )
  .argument(
    '[paths...]',
    'image files, directories and http(s) URLs (several allowed, comma-separated too)',
    [],
  )
  .option('--cwd <path>', 'root paths are resolved against', process.cwd())
  .option('-r, --recursive', 'also walk subdirectories of every given directory', false)
  .option(
    '--files-from <file>',
    'read more paths/URLs from a file, one per line (- = stdin, # starts a comment)',
  )
  .option(
    '--ext <list>',
    'comma-separated image extensions to pick up from directories',
    DEFAULT_IMAGE_EXTENSIONS.join(','),
  )
  .option(
    '--ignore <glob>',
    'extra ignore pattern (repeatable), on top of the built-in defaults',
    (val, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option('--no-respect-gitignore', "don't also honor the project's .gitignore")
  .option(
    '-t, --type <list>',
    'what to generate, comma-separated: hazehash, blurhash, thumbhash, color (dominant), preview (tiny PNG data URI); both = blurhash+thumbhash, all = everything',
    'both',
  )
  .option(
    '--budget <bytes>',
    `hazehash: maximum size of one hash in bytes, header included, ${MIN_HAZEHASH_BUDGET}-${MAX_HAZEHASH_BUDGET} (16-48 is the tuned range)`,
    String(DEFAULT_HAZEHASH_BUDGET),
  )
  .option(
    '--components <XxY|auto>',
    'blurhash components, each side 1-9, or auto to pick them by aspect ratio',
    '4x3',
  )
  .option('--size <px>', 'longest side the image is scaled down to before hashing (1-100)', '100')
  .option(
    '--max-pixels <n>',
    'refuse images with more pixels than this (0 = no limit; default: sharp limit, ~268 million)',
  )
  .option(
    '-f, --format <format>',
    `format of the generated hashes: ${OUTPUT_FORMATS.join(', ')} (plain = just the hash text); --json prints the full report instead`,
    'json',
  )
  .option('--name <identifier>', 'exported constant name for --format ts/js', 'imageHashes')
  .option('--key-base <dir>', 'make the file keys in the output relative to this directory')
  .option('--key-prefix <text>', 'text put in front of every file key, e.g. / for URL-style keys')
  .option('-o, --out <file>', 'write everything into one file instead of stdout')
  .option('--update', 'merge into the existing -o file instead of replacing it', false)
  .option('--prune', 'with --update, drop entries whose image no longer exists', false)
  .option('--per-file', 'write one file per image, next to the image', false)
  .option('--out-dir <dir>', 'write the per-image files into this directory (implies --per-file)')
  .option(
    '--suffix <text>',
    'per-image file name suffix after the image file name, {type} = hazehash/blurhash/thumbhash/hash (default: .{type})',
  )
  .option('--out-ext <ext>', 'per-image file extension (default: by --format, plain = .txt)')
  .option(
    '--check',
    'write nothing; exit 1 if the output files are missing or differ from the images',
    false,
  )
  .option(
    '--cache [file]',
    `skip images that did not change since the last run, remembered in this file (default: ${DEFAULT_CACHE_FILE})`,
  )
  .option('--concurrency <n>', 'images processed in parallel', '4')
  .option('--dry-run', 'write nothing — show the result as a table instead', false)
  .option('-y, --yes', 'install the missing "sharp" image library without asking', false)
  .option('--json', 'machine-readable output', false)
  .option('--quiet', 'suppress output when there is nothing to report', false)
  .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
  .option('--color', 'force colored output even when piped or in CI', false)
  .action(
    async (
      paths: string[],
      options: {
        cwd: string
        recursive: boolean
        filesFrom?: string
        ext: string
        ignore: string[]
        respectGitignore: boolean
        type: string
        components: string
        budget: string
        size: string
        maxPixels?: string
        format: string
        name: string
        keyBase?: string
        keyPrefix?: string
        out?: string
        update: boolean
        prune: boolean
        perFile: boolean
        outDir?: string
        suffix?: string
        outExt?: string
        check: boolean
        cache?: string | boolean
        concurrency: string
        dryRun: boolean
        yes: boolean
        json: boolean
        quiet: boolean
        plain: boolean
        color: boolean
      },
    ) => {
      const style = createStyle({ plain: options.plain, color: options.color })
      const showProgress =
        !options.json && !options.quiet && Boolean(process.stderr.isTTY) && !options.plain
      let progressShown = false
      try {
        const listed =
          options.filesFrom !== undefined
            ? parseFileList(readFileSync(options.filesFrom === '-' ? 0 : options.filesFrom, 'utf8'))
            : []
        const report = await runImageHash({
          paths: [...paths, ...listed],
          cwd: resolve(options.cwd),
          types: parseTypes(options.type),
          recursive: options.recursive,
          extensions: parseExtensions(options.ext),
          ignoreGlobs: options.ignore,
          respectGitignore: options.respectGitignore,
          components: parseComponents(options.components),
          budget: parseBudget(options.budget),
          size: parseSampleSize(options.size),
          ...(options.maxPixels !== undefined
            ? { maxPixels: parseMaxPixels(options.maxPixels) }
            : {}),
          format: parseFormat(options.format),
          exportName: options.name,
          ...(options.keyBase !== undefined ? { keyBase: options.keyBase } : {}),
          ...(options.keyPrefix !== undefined ? { keyPrefix: options.keyPrefix } : {}),
          ...(options.out !== undefined ? { out: options.out } : {}),
          update: options.update,
          prune: options.prune,
          perFile: options.perFile,
          ...(options.outDir !== undefined ? { outDir: options.outDir } : {}),
          ...(options.suffix !== undefined ? { suffix: options.suffix } : {}),
          ...(options.outExt !== undefined ? { outExtension: options.outExt } : {}),
          check: options.check,
          ...(options.cache !== undefined
            ? { cache: options.cache === true ? DEFAULT_CACHE_FILE : String(options.cache) }
            : {}),
          concurrency: Math.max(1, Number.parseInt(options.concurrency, 10) || 4),
          assumeYes: options.yes,
          dryRun: options.dryRun,
          ...(showProgress
            ? {
                onProgress: ({ done, total }: { done: number; total: number }) => {
                  if (total < 2) return
                  progressShown = true
                  process.stderr.write(`\r${style.info(`Hashing ${done}/${total}`)}`)
                },
              }
            : {}),
        })

        if (progressShown) process.stderr.write('\r\x1b[K')

        if (options.json) {
          console.log(JSON.stringify(report, null, 2))
        } else if (report.stdout !== null) {
          process.stdout.write(report.stdout)
          for (const error of report.errors) console.error(`${error.file} — ${error.message}`)
        } else {
          const text = renderImageHashReport(report, {
            quiet: options.quiet,
            plain: options.plain,
            color: options.color,
          })
          if (text) console.log(text)
        }

        process.exitCode = report.exitCode
      } catch (error) {
        if (progressShown) process.stderr.write('\r\x1b[K')
        if (error instanceof ImageHashUsageError) {
          console.error(`error: ${error.message}`)
          process.exitCode = 2
          return
        }
        throw error
      }
    },
  )

registerImageBatch(program)
registerUi(program)

program.parse(process.argv)
