import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStyle } from '../../format/style.js'
import { formatBytes } from '../../format/bytes.js'
import { banner, type VibesOptions } from '../../format/vibes.js'
import { defaultTerminal, isInteractive, promptChoice, type TerminalIO } from '../../utils/tty.js'
import { loadJournal } from './backup.js'
import { ImageBatchUsageError } from './errors.js'
import { writeAtomic } from './process.js'

export type RestoreStatus =
  'restored' | 'would-restore' | 'modified' | 'missing-backup' | 'damaged-backup' | 'error'

export interface RestoreOptions {
  dir: string
  cwd: string
  dryRun?: boolean
  force?: boolean
  assumeYes?: boolean
  interactive?: boolean
  io?: TerminalIO
  style?: VibesOptions
}

export interface RestoreEntryResult {
  path: string
  status: RestoreStatus
  bytes?: number
  message?: string
}

export interface RestoreReport {
  dir: string
  dryRun: boolean
  results: RestoreEntryResult[]
  counts: Record<RestoreStatus, number>
  cancelled: boolean
  exitCode: number
}

const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex')

export async function runRestore(options: RestoreOptions): Promise<RestoreReport> {
  const dir = resolve(options.cwd, options.dir)
  const journal = loadJournal(dir)
  const io = options.io ?? defaultTerminal()
  const interactive = options.interactive ?? isInteractive(io)
  const report: RestoreReport = {
    dir,
    dryRun: Boolean(options.dryRun),
    results: [],
    counts: {
      restored: 0,
      'would-restore': 0,
      modified: 0,
      'missing-backup': 0,
      'damaged-backup': 0,
      error: 0,
    },
    cancelled: false,
    exitCode: 0,
  }

  if (!options.dryRun && !options.assumeYes) {
    if (!interactive) {
      throw new ImageBatchUsageError(
        'restore overwrites the current files with the saved originals — pass --yes to confirm (or --dry-run to preview)',
      )
    }
    const style = createStyle(options.style ?? {})
    const answer = await promptChoice(
      io,
      `${style.warn('Restore')} ${style.value(`${journal.entries.length} files`)} from ${style.path(dir)}?`,
      [
        { key: 'y', label: 'restore' },
        { key: 'n', label: 'cancel' },
      ],
      style,
      'n',
    )
    if (answer !== 'y') {
      report.cancelled = true
      report.exitCode = 1
      return report
    }
  }

  for (const entry of journal.entries) {
    const result: RestoreEntryResult = {
      path: entry.path,
      status: 'restored',
      bytes: entry.bytesBefore,
    }
    try {
      if (!existsSync(entry.backup)) {
        result.status = 'missing-backup'
      } else {
        const saved = readFileSync(entry.backup)
        if (sha1(saved) !== entry.hashBefore) {
          result.status = 'damaged-backup'
        } else {
          const current = existsSync(entry.path) ? sha1(readFileSync(entry.path)) : null
          if (current !== null && current !== entry.hashAfter && !options.force) {
            result.status = 'modified'
          } else if (options.dryRun) {
            result.status = 'would-restore'
          } else {
            writeAtomic(entry.path, saved)
          }
        }
      }
    } catch (error) {
      result.status = 'error'
      result.message = error instanceof Error ? error.message : String(error)
    }
    report.counts[result.status] += 1
    report.results.push(result)
  }

  const failed =
    report.counts.modified +
    report.counts['missing-backup'] +
    report.counts['damaged-backup'] +
    report.counts.error
  report.exitCode = failed > 0 ? 1 : 0
  return report
}

export function renderRestoreReport(report: RestoreReport, options: VibesOptions = {}): string {
  const s = createStyle(options)
  const lines: string[] = []
  if (!options.quiet && !options.plain) lines.push(banner(options), '')
  if (report.cancelled) return [...lines, s.info('Cancelled — nothing restored.')].join('\n')

  const verb = report.dryRun ? 'would be restored' : 'restored'
  const done = report.dryRun ? report.counts['would-restore'] : report.counts.restored
  const total = report.results.length
  lines.push(`${s.heading('Backup')} ${s.path(report.dir)}`, '')
  for (const result of report.results) {
    if (result.status === 'restored' || result.status === 'would-restore') continue
    const reason: Record<RestoreStatus, string> = {
      restored: '',
      'would-restore': '',
      modified: 'changed since it was replaced — left alone (use --force to restore anyway)',
      'missing-backup': 'the backup copy is gone',
      'damaged-backup': 'the backup copy does not match what was saved',
      error: result.message ?? 'failed',
    }
    lines.push(`  ${s.path(result.path)} ${s.muted('—')} ${s.error(reason[result.status])}`)
  }
  if (lines.length > 2) lines.push('')
  const sizes = report.results
    .filter((r) => r.status === 'restored' || r.status === 'would-restore')
    .reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  lines.push(
    (done === total ? s.success : s.warn)(`${done} of ${total} ${verb}`) +
      (sizes > 0 ? s.muted(` (${formatBytes(sizes)} of originals)`) : ''),
  )
  if (report.dryRun)
    lines.push('', s.hint('(dry run — nothing written; drop --dry-run to restore)'))
  return lines.join('\n')
}
