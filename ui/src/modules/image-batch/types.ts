export type Placement = 'out' | 'beside' | 'replace'
export type OverwriteMode = 'overwrite' | 'skip' | 'error'
export type SizeMethod =
  'original' | 'widths' | 'heights' | 'size' | 'longEdge' | 'shortEdge' | 'megapixels' | 'percent'

export interface BatchOptions {
  formats: string[]
  qualityLevels: string[]
  sizeMethods: SizeMethod[]
  fitModes: string[]
  sharpen: {
    targets: string[]
    amounts: string[]
    fine: { key: string; range: [number, number] }[]
    builtIn: string[]
  }
  templateVariables: string[]
  defaultTemplates: Record<string, string>
  sharp: boolean
}

export type JobStatus =
  | 'written'
  | 'up-to-date'
  | 'skipped'
  | 'conflict'
  | 'would-write'
  | 'would-overwrite'
  | 'replaced'
  | 'kept'
  | 'already-processed'
  | 'would-replace'
  | 'would-keep'
  | 'error'

export interface BatchResult {
  source: string
  sourceAbs: string
  output: string
  outputAbs: string
  recipe: string
  format: string
  width: number
  height: number
  status: JobStatus
  bytes?: number
  before?: number
  message?: string
}

export interface BatchReport {
  placement: Placement
  out: string
  backupDir?: string
  backupEnabled: boolean
  configLabel?: string
  dryRun: boolean
  failures: { file: string; message: string }[]
  unmatched: string[]
  derived: string[]
  vectors: string[]
  results: BatchResult[]
  counts: Record<JobStatus, number>
  deduped: number
  bytesIn: number
  bytesOut: number
  aborted: boolean
  cancelled: boolean
  exitCode: number
}

export interface ConfigRow {
  name: string
  scope: 'project' | 'global'
  path: string
  kind: 'json' | 'js' | 'mjs' | 'ts'
  editable: boolean
  title?: string
  description?: string
  recipes: number
  rules: number
  error?: string
}

export interface SharpenPresetRow {
  name: string
  scope: 'project' | 'global' | 'built-in'
  path?: string
  description?: string
  fields?: Record<string, unknown>
  params?: { sigma: number; m1: number; m2: number; x1?: number }
  error?: string
}

export interface SharpenState {
  mode: 'none' | 'preset' | 'custom'
  preset: string
  for: string
  amount: string
  fine: Record<'radius' | 'flat' | 'jagged' | 'threshold', string>
}

export function emptySharpen(): SharpenState {
  return {
    mode: 'none',
    preset: '',
    for: 'screen',
    amount: 'standard',
    fine: { radius: '', flat: '', jagged: '', threshold: '' },
  }
}

export function sharpenPayload(state: SharpenState): Record<string, unknown> | undefined {
  if (state.mode === 'none') return undefined
  if (state.mode === 'preset') return state.preset ? { preset: state.preset } : undefined
  const payload: Record<string, unknown> = { for: state.for, amount: state.amount }
  for (const [key, value] of Object.entries(state.fine)) {
    if (value.trim() !== '') payload[key] = Number(value)
  }
  return payload
}
