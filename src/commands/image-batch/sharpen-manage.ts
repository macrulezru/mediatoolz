import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createStyle } from '../../format/style.js'
import { renderTable, type TableColumn } from '../../format/table.js'
import type { VibesOptions } from '../../format/vibes.js'
import {
  askText,
  isInteractive,
  promptChoice,
  singleSelect,
  type SelectItem,
} from '../../utils/tty.js'
import { CONFIG_DIR_SEGMENTS } from './config.js'
import { ImageBatchUsageError } from './errors.js'
import { validName, writeJson, type ManageEnv } from './manage.js'
import { askSharpenFields } from './sharpen-ask.js'
import {
  SHARPEN_FINE_KEYS,
  completeSharpen,
  describeSharpen,
  parseSharpenFields,
  sharpenParams,
  type SharpenFields,
} from './sharpen.js'
import {
  SHARPEN_DIR_NAME,
  discoverSharpenPresets,
  findSharpenPreset,
  globalSharpenDir,
  readSharpenPreset,
  type SharpenPresetLocation,
} from './sharpen-presets.js'

export interface SharpenRow {
  location: SharpenPresetLocation
  description?: string
  fields?: SharpenFields
  error?: string
}

export interface SharpenNewOptions {
  name?: string
  global?: boolean
  description?: string
  fields?: SharpenFields
  force?: boolean
}

export function sharpenDir(scope: 'project' | 'global', env: Pick<ManageEnv, 'cwd' | 'globalDir'>) {
  return scope === 'global'
    ? globalSharpenDir(env.globalDir)
    : join(env.cwd, ...CONFIG_DIR_SEGMENTS, SHARPEN_DIR_NAME)
}

export function listSharpenRows(env: ManageEnv): SharpenRow[] {
  const discovered = discoverSharpenPresets({
    cwd: env.cwd,
    ...(env.globalDir !== undefined ? { globalDir: env.globalDir } : {}),
  })
  return discovered.map((location) => {
    try {
      const preset = readSharpenPreset(location)
      return {
        location,
        fields: preset.fields,
        ...(preset.description !== undefined ? { description: preset.description } : {}),
      }
    } catch (error) {
      return { location, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

export function renderSharpenTable(rows: SharpenRow[], style: VibesOptions): string[] {
  const s = createStyle(style)
  const columns: TableColumn[] = [
    { header: 'Name', style: s.name },
    { header: 'Scope', style: s.accent },
    { header: 'Settings', style: s.value },
    { header: 'Path', shrink: true, style: s.path },
  ]
  return renderTable(
    columns,
    rows.map((row) => [
      row.location.name,
      row.location.scope,
      row.error ? 'error' : describeSharpen(row.fields ?? {}),
      row.location.path,
    ]),
    style,
  )
}

export function describeSharpenPreset(row: SharpenRow, style: VibesOptions): string[] {
  const s = createStyle(style)
  const lines = [
    `${s.heading(row.location.name)} ${s.muted(`(${row.location.scope})`)}${
      row.description ? s.muted(` — ${row.description}`) : ''
    }`,
    `  ${s.muted('file')} ${s.path(row.location.path)}`,
  ]
  if (row.error || !row.fields) {
    lines.push(`  ${s.error(row.error ?? 'unreadable')}`)
    return lines
  }
  const spec = completeSharpen(row.fields)
  lines.push(
    `  ${s.muted('for')} ${s.value(spec.for)}  ${s.muted('amount')} ${s.value(spec.amount)}`,
  )
  for (const key of SHARPEN_FINE_KEYS) {
    if (row.fields[key] !== undefined) {
      lines.push(`  ${s.muted(key)} ${s.value(String(row.fields[key]))}`)
    }
  }
  const params = sharpenParams(spec)
  lines.push(
    `  ${s.muted('sharp')} sigma ${params.sigma}, flat ${params.m1}, jagged ${params.m2}${
      params.x1 !== undefined ? `, threshold ${params.x1}` : ''
    }`,
  )
  return lines
}

export function sharpenLocationFor(env: ManageEnv, name: string): SharpenPresetLocation {
  return findSharpenPreset(
    name,
    discoverSharpenPresets({
      cwd: env.cwd,
      ...(env.globalDir !== undefined ? { globalDir: env.globalDir } : {}),
    }),
  )
}

export function showSharpenPreset(env: ManageEnv, name: string): void {
  const location = sharpenLocationFor(env, name)
  const row: SharpenRow = { location }
  try {
    const preset = readSharpenPreset(location)
    row.fields = preset.fields
    if (preset.description !== undefined) row.description = preset.description
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error)
  }
  env.log(describeSharpenPreset(row, env.style).join('\n'))
}

export function removeSharpenPreset(location: SharpenPresetLocation, force: boolean): string {
  if (location.scope === 'built-in') {
    throw new ImageBatchUsageError(
      `${location.name} is a built-in preset and cannot be deleted — copy it to this project with the sharpen command to change it`,
    )
  }
  if (force) {
    rmSync(location.path, { force: true })
    return location.path
  }
  const backup = `${location.path}.bak`
  if (existsSync(backup)) rmSync(backup, { force: true })
  renameSync(location.path, backup)
  return backup
}

function writePreset(
  env: ManageEnv,
  name: string,
  scope: 'project' | 'global',
  fields: SharpenFields,
  description: string | undefined,
  force: boolean,
): string {
  const path = join(sharpenDir(scope, env), `${name}.json`)
  if (existsSync(path) && !force) {
    throw new ImageBatchUsageError(`${path} already exists — pick another name or pass --force`)
  }
  writeJson(path, { ...(description ? { description } : {}), ...fields })
  return path
}

export async function runSharpenNew(env: ManageEnv, options: SharpenNewOptions): Promise<string> {
  const s = createStyle(env.style)
  const interactive = isInteractive(env.io)
  let name = options.name
  if (name === undefined) {
    if (!interactive) {
      throw new ImageBatchUsageError(
        'sharpen new needs --name <name> when it is not run in a terminal',
      )
    }
    const answer = await askText(env.io, 'Name of the sharpen preset:', s, 'web-crisp')
    if (answer === null) throw new ImageBatchUsageError('cancelled')
    name = answer
  }
  const clean = validName(name)
  let scope: 'project' | 'global' = options.global ? 'global' : 'project'
  if (interactive && options.global === undefined) {
    const picked = await singleSelect(
      env.io,
      [
        {
          label: 'This project',
          hint: '.mediatoolz/image-batch/sharpen/',
          value: 'project' as const,
        },
        {
          label: 'All projects',
          hint: '~/.mediatoolz/image-batch/sharpen/',
          value: 'global' as const,
        },
      ],
      { title: 'Where should the preset live?', help: 'enter pick · q cancel' },
      s,
    )
    if (picked === null) throw new ImageBatchUsageError('cancelled')
    scope = picked
  }
  let fields = options.fields
  if (fields === undefined) {
    if (!interactive) {
      throw new ImageBatchUsageError(
        'sharpen new needs at least one of --sharpen-for, --sharpen-amount, --sharpen-radius, --sharpen-flat, --sharpen-jagged, --sharpen-threshold when it is not run in a terminal',
      )
    }
    const asked = await askSharpenFields(env, s)
    if (asked === null) throw new ImageBatchUsageError('cancelled')
    fields = asked
  }
  parseSharpenFields({ ...fields }, clean, false)
  const path = writePreset(env, clean, scope, fields, options.description, options.force ?? false)
  env.log(`${s.success('Created')} ${s.path(path)}`)
  env.log(
    s.hint(
      `(use it with: mediatoolz image-batch <folder> -o <out> --sharpen ${clean} — or "sharpen": "${clean}" in a config)`,
    ),
  )
  return path
}

export async function manageSharpenPresets(env: ManageEnv): Promise<void> {
  const s = createStyle(env.style)
  if (!isInteractive(env.io)) {
    const rows = listSharpenRows(env)
    env.log(
      rows.length === 0
        ? s.warn('No sharpen presets found — create one with `mediatoolz image-batch sharpen new`.')
        : renderSharpenTable(rows, env.style).join('\n'),
    )
    return
  }
  for (;;) {
    const rows = listSharpenRows(env)
    const items: SelectItem<SharpenRow | 'new'>[] = [
      ...rows.map((row) => ({
        label: row.location.name,
        hint: row.error
          ? `unreadable — ${row.error.slice(0, 50)}`
          : `${row.location.scope} · ${describeSharpen(row.fields ?? {})}`,
        value: row,
      })),
      { label: '+ new preset', hint: 'wizard', value: 'new' as const },
    ]
    const picked = await singleSelect(
      env.io,
      items,
      { title: 'Sharpen presets', help: 'enter open · / filter · q quit', filterable: true },
      s,
    )
    if (picked === null) return
    try {
      if (picked === 'new') {
        await runSharpenNew(env, {})
        continue
      }
      const location = picked.location
      const action = await singleSelect(
        env.io,
        [
          { label: 'Show', hint: 'the settings and what sharp receives', value: 'show' },
          ...(location.scope === 'built-in'
            ? []
            : [{ label: 'Edit', hint: 'the same questions as for a new preset', value: 'edit' }]),
          {
            label: location.scope === 'project' ? 'Copy to global' : 'Copy to this project',
            hint: location.scope === 'built-in' ? 'to change it as your own' : '',
            value: 'copy',
          },
          ...(location.scope === 'built-in' ? [] : [{ label: 'Delete', value: 'delete' }]),
          { label: '— back —', value: 'back' },
        ],
        { title: `${location.name}  ${location.scope}`, help: 'enter pick · q back' },
        s,
      )
      if (action === 'show') {
        env.log(describeSharpenPreset(picked, env.style).join('\n'))
      } else if (action === 'edit') {
        const fields = await askSharpenFields(env, s, picked.fields ?? {})
        if (fields !== null) {
          writeJson(location.path, {
            ...(picked.description ? { description: picked.description } : {}),
            ...fields,
          })
          env.log(`${s.success('Saved')} ${s.path(location.path)}`)
        }
      } else if (action === 'copy' && picked.fields) {
        const target = location.scope === 'project' ? 'global' : 'project'
        const path = writePreset(
          env,
          location.name,
          target,
          picked.fields,
          picked.description,
          false,
        )
        env.log(`${s.success('Copied to')} ${s.path(path)}`)
      } else if (action === 'delete') {
        const answer = await promptChoice(
          env.io,
          `Delete ${location.name}? A .bak copy stays.`,
          [
            { key: 'y', label: 'yes' },
            { key: 'n', label: 'no' },
          ],
          s,
          'n',
        )
        if (answer === 'y') {
          env.log(`${s.success('Deleted')} ${s.path(removeSharpenPreset(location, false))}`)
        }
      }
    } catch (error) {
      env.log(s.error(error instanceof Error ? error.message : String(error)))
    }
  }
}
