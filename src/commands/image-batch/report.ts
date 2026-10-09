import { formatBytes, formatPercent } from '../../format/bytes.js'
import { createStyle, type Style } from '../../format/style.js'
import { renderTable, type TableColumn } from '../../format/table.js'
import { banner, type VibesOptions } from '../../format/vibes.js'
import type { BatchJobResult, ImageBatchReport, JobStatus } from './run.js'

const TABLE_LIMIT = 40

const STATUS_LABEL: Record<JobStatus, string> = {
  written: 'written',
  'up-to-date': 'up to date',
  skipped: 'skipped',
  conflict: 'exists',
  'would-write': 'would write',
  'would-overwrite': 'would overwrite',
  replaced: 'replaced',
  kept: 'kept (not smaller)',
  'already-processed': 'already done',
  'would-replace': 'would replace',
  'would-keep': 'would keep',
  error: 'error',
}

function statusStyle(s: Style, status: JobStatus): (text: string) => string {
  switch (status) {
    case 'written':
    case 'replaced':
      return s.success
    case 'up-to-date':
    case 'already-processed':
    case 'kept':
    case 'would-keep':
      return s.muted
    case 'skipped':
    case 'would-overwrite':
      return s.warn
    case 'would-write':
    case 'would-replace':
      return s.name
    default:
      return s.problem
  }
}

export interface ImageBatchRenderOptions extends VibesOptions {
  verbose?: boolean
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function paintStatus(
  lines: string[],
  results: BatchJobResult[],
  s: Style,
  firstRow: number,
): string[] {
  return lines.map((line, index) => {
    const result = results[index - firstRow]
    if (!result) return line
    const label = STATUS_LABEL[result.status]
    const at = line.lastIndexOf(label)
    if (at === -1) return line
    return `${line.slice(0, at)}${statusStyle(s, result.status)(label)}${line.slice(at + label.length)}`
  })
}

function outputTable(results: BatchJobResult[], options: VibesOptions): string[] {
  const s = createStyle(options)
  const columns: TableColumn[] = [
    { header: 'Source', shrink: true, style: s.path },
    { header: 'Output', style: s.value },
    { header: 'Size', align: 'right', style: s.tag },
    { header: 'Bytes', align: 'right', style: s.tag },
    { header: 'Status' },
  ]
  const rows = results.map((result) => [
    result.source,
    result.output,
    `${result.width}×${result.height}`,
    result.bytes === undefined ? '' : formatBytes(result.bytes),
    STATUS_LABEL[result.status],
  ])
  return paintStatus(renderTable(columns, rows, options), results, s, 3)
}

function replaceTable(results: BatchJobResult[], options: VibesOptions): string[] {
  const s = createStyle(options)
  const columns: TableColumn[] = [
    { header: 'File', shrink: true, style: s.path },
    { header: 'Size', align: 'right', style: s.tag },
    { header: 'Was', align: 'right', style: s.tag },
    { header: 'Now', align: 'right', style: s.value },
    { header: 'Status' },
  ]
  const rows = results.map((result) => [
    result.source,
    `${result.width}×${result.height}`,
    result.before === undefined ? '' : formatBytes(result.before),
    result.bytes === undefined || result.status === 'error' ? '' : formatBytes(result.bytes),
    STATUS_LABEL[result.status],
  ])
  return paintStatus(renderTable(columns, rows, options), results, s, 3)
}

function targetLine(report: ImageBatchReport, s: Style): string {
  if (report.placement === 'replace') {
    const backup = report.backupDir
      ? `backup ${s.path(report.backupDir)}`
      : report.dryRun || report.backupEnabled
        ? ''
        : s.warn('no backup')
    return `${s.info('→')} ${s.name('in place')}${backup ? `  ${s.muted(backup)}` : ''}`
  }
  if (report.placement === 'beside') return `${s.info('→')} ${s.name('next to the sources')}`
  return `${s.info('→')} ${s.path(report.out)}`
}

export function renderImageBatchReport(
  report: ImageBatchReport,
  options: ImageBatchRenderOptions = {},
): string {
  const s = createStyle(options)
  const lines: string[] = []
  const { counts } = report
  const problems = counts.error + counts.conflict + report.failures.length
  const clean = problems === 0 && counts.skipped === 0 && !report.aborted

  if (options.quiet && clean && !report.cancelled) return ''
  if (!options.quiet && !options.plain) lines.push(banner(options), '')

  if (report.listOnly) {
    lines.push(s.heading(`${plural(report.sources.length, 'image')} found:`))
    for (const source of report.sources) {
      lines.push(
        `  ${s.path(source.file)}  ${s.muted(`${source.width}×${source.height} · ${source.format} · ${formatBytes(source.bytes)}`)}`,
      )
    }
    for (const failure of report.failures) {
      lines.push(`  ${s.path(failure.file)} ${s.muted('—')} ${s.error(failure.message)}`)
    }
    return lines.join('\n')
  }

  if (report.cancelled) {
    return [...lines, s.info('Cancelled — nothing was changed.')].join('\n')
  }

  if (report.nothingSelected) {
    return [...lines, s.info('Nothing selected — nothing to do.')].join('\n')
  }

  if (report.sources.length === 0 && report.failures.length === 0) {
    return [...lines, s.warn('No images found in the given paths.')].join('\n')
  }

  const configNote = report.configLabel ? `  ${s.muted(`config ${report.configLabel}`)}` : ''
  lines.push(
    `${s.heading(plural(report.sources.length, 'image'))} ${targetLine(report, s)}${configNote}`,
    '',
  )

  const quietStatuses: JobStatus[] =
    report.placement === 'replace'
      ? ['replaced', 'kept', 'already-processed']
      : ['written', 'up-to-date']
  const showAll = options.verbose || report.results.length <= TABLE_LIMIT || report.dryRun
  const shown = showAll
    ? report.results
    : report.results.filter((result) => !quietStatuses.includes(result.status))
  if (shown.length > 0) {
    lines.push(
      ...(report.placement === 'replace'
        ? replaceTable(shown, options)
        : outputTable(shown, options)),
      '',
    )
  }
  if (!showAll && shown.length < report.results.length) {
    lines.push(
      s.info(
        shown.length === 0
          ? `(${plural(report.results.length, 'file')} not listed — use --verbose)`
          : `(${report.results.length - shown.length} more not shown — use --verbose)`,
      ),
      '',
    )
  }

  const parts: string[] = []
  if (report.placement === 'replace') {
    if (report.dryRun) {
      parts.push(s.name(`${counts['would-replace']} would be replaced`))
      if (counts['would-keep'] > 0) parts.push(s.muted(`${counts['would-keep']} would be kept`))
    } else {
      parts.push(
        counts.replaced > 0 ? s.success(`${counts.replaced} replaced`) : s.muted('0 replaced'),
      )
      if (counts.kept > 0) parts.push(s.muted(`${counts.kept} kept (not smaller)`))
    }
    if (counts['already-processed'] > 0)
      parts.push(s.muted(`${counts['already-processed']} already done`))
  } else if (report.dryRun) {
    parts.push(s.name(`${counts['would-write']} would be written`))
    if (counts['would-overwrite'] > 0) {
      parts.push(s.warn(`${counts['would-overwrite']} would overwrite`))
    }
    if (counts['up-to-date'] > 0) parts.push(s.muted(`${counts['up-to-date']} up to date`))
  } else {
    parts.push(counts.written > 0 ? s.success(`${counts.written} written`) : s.muted('0 written'))
    if (counts['up-to-date'] > 0) parts.push(s.muted(`${counts['up-to-date']} up to date`))
    if (counts.skipped > 0) parts.push(s.warn(`${counts.skipped} skipped (exist)`))
  }
  if (counts.conflict > 0) parts.push(s.problem(`${counts.conflict} blocked (exist)`))
  if (counts.error > 0) parts.push(s.problem(plural(counts.error, 'error')))
  lines.push(parts.join(s.muted(' · ')))

  if (report.placement === 'replace') {
    const before = report.results
      .filter((r) => r.status === (report.dryRun ? 'would-replace' : 'replaced'))
      .reduce((sum, r) => sum + (r.before ?? 0), 0)
    const after = report.results
      .filter((r) => r.status === (report.dryRun ? 'would-replace' : 'replaced'))
      .reduce((sum, r) => sum + (r.bytes ?? 0), 0)
    if (before > 0) {
      const saved = before - after
      lines.push(
        s.info(
          `${report.dryRun ? 'Would save' : 'Saved'} ${formatBytes(saved)} (${formatPercent(saved, before)} of ${formatBytes(before)}): ${formatBytes(before)} → ${formatBytes(after)}.`,
        ),
      )
    }
    if (report.backupDir) {
      lines.push(
        s.info(
          `Originals saved to ${s.path(report.backupDir)} — undo with: mediatoolz image-batch restore ${report.backupDir}`,
        ),
      )
    }
  } else if (report.bytesOut > 0) {
    lines.push(
      s.info(
        `Wrote ${plural(counts.written, 'file')}, ${formatBytes(report.bytesOut)} (the sources they came from: ${formatBytes(report.bytesIn)}).`,
      ),
    )
  }
  if (report.deduped > 0) {
    lines.push(
      s.info(
        `${plural(report.deduped, 'duplicate output')} merged (a requested size above the source size resolves to the same file).`,
      ),
    )
  }
  if (report.emitPath) lines.push(s.info(`Manifest: ${s.path(report.emitPath)}`))

  if (report.derived.length > 0) {
    lines.push(
      '',
      s.info(
        `${plural(report.derived.length, 'file')} left alone: ${report.derived.length === 1 ? 'it looks' : 'they look'} like results of an earlier run.`,
      ),
    )
    for (const file of report.derived.slice(0, 5)) lines.push(`  ${s.path(file)}`)
    if (report.derived.length > 5) lines.push(s.muted(`  … and ${report.derived.length - 5} more`))
  }

  if (report.vectors.length > 0) {
    lines.push(
      '',
      s.info(
        `${plural(report.vectors.length, 'svg file')} left alone: a vector has no pixels to shrink, --replace only changes rasters.`,
      ),
    )
  }

  if (report.unmatched.length > 0) {
    lines.push(
      '',
      s.warn(`${plural(report.unmatched.length, 'image')} matched no rule and were left alone:`),
    )
    for (const file of report.unmatched.slice(0, 10)) lines.push(`  ${s.path(file)}`)
    if (report.unmatched.length > 10) {
      lines.push(s.muted(`  … and ${report.unmatched.length - 10} more`))
    }
  }

  if (report.results.some((result) => result.status === 'error')) {
    lines.push('', s.problem('Errors:'))
    for (const result of report.results.filter((r) => r.status === 'error')) {
      lines.push(
        `  ${s.path(result.source)} ${s.muted('→')} ${s.value(result.output)} ${s.muted('—')} ${s.error(result.message ?? 'failed')}`,
      )
    }
  }
  if (report.failures.length > 0) {
    lines.push('', s.problem(`${plural(report.failures.length, 'image')} could not be read:`))
    for (const failure of report.failures) {
      lines.push(`  ${s.path(failure.file)} ${s.muted('—')} ${s.error(failure.message)}`)
    }
  }
  if (report.counts.skipped > 0 && report.exitCode !== 0) {
    lines.push(
      '',
      s.hint(
        '(existing files were skipped — pass --overwrite to replace them, or --skip-existing to accept skipping)',
      ),
    )
  }
  if (report.aborted) {
    lines.push('', s.warn('Stopped at your request — the files written so far are kept.'))
  }
  if (report.dryRun) {
    lines.push('', s.hint('(dry run — nothing written; drop --dry-run to write the files)'))
  }
  return lines.join('\n')
}
