import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  DEFAULT_BACKUP_DIR,
  JOURNAL_FILE,
  loadJournal,
  type Journal,
} from '../../image-batch/backup.js'
import { ImageBatchUsageError } from '../../image-batch/errors.js'
import { runRestore, type RestoreReport } from '../../image-batch/restore.js'
import { resolveUserPath } from '../fs-routes.js'
import { HttpError, asObject, sendJson, type Route, type RouteContext } from '../http.js'

function usage<T>(task: () => T): T {
  try {
    return task()
  } catch (error) {
    if (error instanceof ImageBatchUsageError) throw new HttpError(400, error.message)
    throw error
  }
}

function summary(dir: string, journal: Journal) {
  return {
    dir,
    name: basename(dir),
    createdAt: journal.createdAt,
    cwd: journal.cwd,
    files: journal.entries.length,
    bytesBefore: journal.entries.reduce((sum, entry) => sum + entry.bytesBefore, 0),
    bytesAfter: journal.entries.reduce((sum, entry) => sum + entry.bytesAfter, 0),
  }
}

function dirFrom(ctx: RouteContext, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new HttpError(400, 'give the backup folder')
  const dir = resolveUserPath(value, ctx.server.cwd)
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new HttpError(404, `${dir} is not a folder`)
  }
  return dir
}

function listBackups(ctx: RouteContext): void {
  const root = join(ctx.server.cwd, DEFAULT_BACKUP_DIR)
  const rows: ReturnType<typeof summary>[] = []
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      if (!existsSync(join(dir, JOURNAL_FILE))) continue
      try {
        rows.push(summary(dir, loadJournal(dir)))
      } catch {
        continue
      }
    }
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  sendJson(ctx.res, 200, { root, backups: rows })
}

function sha1(path: string): string | undefined {
  try {
    return createHash('sha1').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

async function inspect(ctx: RouteContext): Promise<void> {
  const dir = dirFrom(ctx, ctx.url.searchParams.get('dir'))
  const journal = usage(() => loadJournal(dir))
  const report = await usage(() => runRestore({ dir, cwd: ctx.server.cwd, dryRun: true }))
  const counts = { ...report.counts }
  const entries = journal.entries.map((entry, index) => {
    let status = report.results[index]?.status ?? 'error'
    if (status === 'modified' && sha1(entry.path) === entry.hashBefore) {
      counts.modified -= 1
      counts.restored += 1
      status = 'restored'
    }
    return {
      path: entry.path,
      backup: entry.backup,
      bytesBefore: entry.bytesBefore,
      bytesAfter: entry.bytesAfter,
      status,
      message: report.results[index]?.message,
    }
  })
  sendJson(ctx.res, 200, { ...summary(dir, journal), counts, entries })
}

async function restore(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const dir = dirFrom(ctx, body.dir)
  const report: RestoreReport = await usage(() =>
    runRestore({
      dir,
      cwd: ctx.server.cwd,
      force: body.force === true,
      assumeYes: true,
      interactive: false,
    }),
  )
  sendJson(ctx.res, 200, report)
}

async function remove(ctx: RouteContext): Promise<void> {
  const body = asObject(await ctx.readBody())
  const dir = dirFrom(ctx, body.dir)
  usage(() => loadJournal(dir))
  rmSync(dir, { recursive: true, force: true })
  sendJson(ctx.res, 200, { deleted: dir })
}

export const backupRoutes: Route[] = [
  { method: 'GET', path: '/api/image-batch/backups', handler: listBackups },
  { method: 'GET', path: '/api/image-batch/backup', handler: inspect },
  { method: 'POST', path: '/api/image-batch/backup/restore', handler: restore },
  { method: 'POST', path: '/api/image-batch/backup/delete', handler: remove },
]
