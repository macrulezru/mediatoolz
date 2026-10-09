import { banner, type VibesOptions } from '../../format/vibes.js'
import { createStyle } from '../../format/style.js'
import { renderTable, type TableColumn } from '../../format/table.js'
import { ALL_TYPES, type HashType } from './core.js'
import type { ImageHashReport } from './run.js'

const TYPE_LABEL: Record<HashType, string> = {
  hazehash: 'HazeHash',
  blurhash: 'BlurHash',
  thumbhash: 'ThumbHash',
  color: 'Color',
  preview: 'Preview',
}

const PREVIEW_CELL_WIDTH = 28

function hashTypesIn(report: ImageHashReport): HashType[] {
  return ALL_TYPES.filter((type) => report.entries.some((entry) => entry[type] !== undefined))
}

function cellText(type: HashType, value: string | undefined): string {
  if (value === undefined) return ''
  if (type === 'preview' && value.length > PREVIEW_CELL_WIDTH) {
    return `${value.slice(0, PREVIEW_CELL_WIDTH - 1)}…`
  }
  return value
}

function imageHashTable(report: ImageHashReport, options: VibesOptions): string[] {
  const s = createStyle(options)
  const types = hashTypesIn(report)
  const typeStyle: Record<HashType, (text: string) => string> = {
    hazehash: s.value,
    blurhash: s.name,
    thumbhash: s.accent,
    color: s.value,
    preview: s.tag,
  }
  const columns: TableColumn[] = [
    { header: 'File', shrink: true, style: s.path },
    { header: 'Size', align: 'right', style: s.tag },
    ...types.map((type) => ({ header: TYPE_LABEL[type], style: typeStyle[type] })),
  ]
  const rows = report.entries.map((entry) => [
    entry.file,
    `${entry.width}×${entry.height}`,
    ...types.map((type) => cellText(type, entry[type])),
  ])
  return renderTable(columns, rows, options)
}

export function renderImageHashReport(report: ImageHashReport, options: VibesOptions = {}): string {
  const s = createStyle(options)
  const lines: string[] = []
  const isClean = report.errors.length === 0 && report.outdated.length === 0
  if (options.quiet && isClean) return ''

  if (!options.quiet && !options.plain) lines.push(banner(options), '')

  if (report.dryRun && report.entries.length > 0) {
    lines.push(...imageHashTable(report, options), '')
  }

  const count = report.entries.length
  const cachedNote = report.cached > 0 ? `, ${report.cached} from the cache` : ''
  lines.push(s.info(`Hashed ${count} image${count === 1 ? '' : 's'}${cachedNote}.`))

  if (report.check) {
    if (report.outdated.length === 0) {
      lines.push(
        '',
        s.success(
          `All ${report.checked} output file${report.checked === 1 ? ' is' : 's are'} up to date.`,
        ),
      )
    } else {
      lines.push(
        '',
        s.problem(
          `${report.outdated.length} of ${report.checked} output file${report.checked === 1 ? '' : 's'} out of date:`,
        ),
      )
      for (const item of report.outdated) {
        const reason = item.reason === 'missing' ? 'missing' : 'differs from the images'
        lines.push(`  ${s.path(item.file)} ${s.muted('—')} ${s.error(reason)}`)
      }
      lines.push('', s.hint('(regenerate them by running the same command without --check)'))
    }
  }

  if (report.written.length > 0) {
    const verb = report.dryRun ? 'Would write' : 'Wrote'
    const heading = `${verb} ${report.written.length} file${report.written.length === 1 ? '' : 's'}:`
    lines.push('', report.dryRun ? s.heading(heading) : s.success(heading))
    for (const file of report.written) lines.push(`  ${s.path(file)}`)
  }

  if (report.pruned > 0) {
    lines.push(
      '',
      s.info(
        `Removed ${report.pruned} entr${report.pruned === 1 ? 'y' : 'ies'} whose image no longer exists.`,
      ),
    )
  }

  if (report.dryRun) {
    lines.push(
      '',
      s.hint(
        report.written.length > 0
          ? '(dry run — nothing written; drop --dry-run to write the files)'
          : '(dry run — nothing written)',
      ),
    )
  }

  if (report.errors.length > 0) {
    lines.push(
      '',
      s.problem(`${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}:`),
    )
    for (const error of report.errors) {
      lines.push(`  ${s.path(error.file)} ${s.muted('—')} ${s.error(error.message)}`)
    }
  }

  return lines.join('\n')
}
