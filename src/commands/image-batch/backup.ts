import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ImageBatchUsageError } from './errors.js'

export const DEFAULT_BACKUP_DIR = '.image-batch-backup'
export const JOURNAL_FILE = 'journal.json'

export interface JournalEntry {
  path: string
  backup: string
  bytesBefore: number
  bytesAfter: number
  hashBefore: string
  hashAfter: string
}

export interface Journal {
  version: 1
  createdAt: string
  cwd: string
  entries: JournalEntry[]
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function backupDirFor(cwd: string, base: string | undefined, now: Date): string {
  const root = resolve(cwd, base ?? DEFAULT_BACKUP_DIR)
  let dir = join(root, stamp(now))
  let suffix = 1
  while (existsSync(dir)) {
    suffix += 1
    dir = join(root, `${stamp(now)}-${suffix}`)
  }
  return dir
}

export function backupPathFor(backupDir: string, cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return join(backupDir, '_outside', absolute.replace(/[:\\/]+/g, '_'))
  }
  return join(backupDir, rel)
}

export function copyIntoBackup(source: string, backup: string): void {
  mkdirSync(dirname(backup), { recursive: true })
  copyFileSync(source, backup)
}

export function newJournal(cwd: string, now: Date): Journal {
  return { version: 1, createdAt: now.toISOString(), cwd, entries: [] }
}

export function saveJournal(backupDir: string, journal: Journal): void {
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(join(backupDir, JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`)
}

export function loadJournal(backupDir: string): Journal {
  const path = join(backupDir, JOURNAL_FILE)
  if (!existsSync(path)) {
    throw new ImageBatchUsageError(
      `${backupDir} has no ${JOURNAL_FILE} — pass the dated backup folder that --replace created`,
    )
  }
  let parsed: Journal
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Journal
  } catch (error) {
    throw new ImageBatchUsageError(
      `${path}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new ImageBatchUsageError(`${path}: not a journal written by image-batch`)
  }
  return parsed
}
