import type { Style } from '../format/style.js'

export interface TerminalInput {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => unknown
  resume: () => unknown
  pause: () => unknown
  setEncoding?: (encoding: BufferEncoding) => unknown
  on: (event: 'data', listener: (chunk: string | Buffer) => void) => unknown
  off: (event: 'data', listener: (chunk: string | Buffer) => void) => unknown
}

export interface TerminalOutput {
  isTTY?: boolean
  columns?: number
  rows?: number
  write: (text: string) => unknown
}

export interface TerminalIO {
  input: TerminalInput
  output: TerminalOutput
}

export interface Key {
  name: string
  ch?: string
  ctrl?: boolean
}

const ESCAPES: Record<string, string> = {
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  OA: 'up',
  OB: 'down',
  OC: 'right',
  OD: 'left',
  '[H': 'home',
  '[F': 'end',
  OH: 'home',
  OF: 'end',
  '[1~': 'home',
  '[4~': 'end',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  '[3~': 'delete',
}

export function parseKeys(data: string): Key[] {
  const keys: Key[] = []
  let i = 0
  while (i < data.length) {
    const ch = data[i] as string
    if (ch === '\x1b') {
      let matched = false
      for (const length of [4, 3, 2]) {
        const name = ESCAPES[data.slice(i + 1, i + length)]
        if (name !== undefined) {
          keys.push({ name })
          i += length
          matched = true
          break
        }
      }
      if (!matched) {
        keys.push({ name: 'escape' })
        i += 1
      }
    } else if (ch === '\x03') {
      keys.push({ name: 'c', ctrl: true })
      i += 1
    } else if (ch === '\r' || ch === '\n') {
      keys.push({ name: 'enter' })
      i += ch === '\r' && data[i + 1] === '\n' ? 2 : 1
    } else if (ch === '\x7f' || ch === '\b') {
      keys.push({ name: 'backspace' })
      i += 1
    } else if (ch === ' ') {
      keys.push({ name: 'space', ch })
      i += 1
    } else if (ch === '\t') {
      keys.push({ name: 'tab' })
      i += 1
    } else if (ch >= ' ') {
      keys.push({ name: ch, ch })
      i += 1
    } else {
      i += 1
    }
  }
  return keys
}

export class KeyReader {
  private readonly queue: Key[] = []
  private waiting: ((key: Key) => void) | null = null
  private readonly listener = (chunk: string | Buffer) => {
    for (const key of parseKeys(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) {
      if (this.waiting) {
        const resolve = this.waiting
        this.waiting = null
        resolve(key)
      } else {
        this.queue.push(key)
      }
    }
  }

  constructor(private readonly input: TerminalInput) {
    input.setEncoding?.('utf8')
    input.setRawMode?.(true)
    input.resume()
    input.on('data', this.listener)
  }

  next(): Promise<Key> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }

  close(): void {
    this.input.off('data', this.listener)
    this.input.setRawMode?.(false)
    this.input.pause()
  }
}

export function isInteractive(io: TerminalIO): boolean {
  return Boolean(io.input.isTTY) && Boolean(io.output.isTTY)
}

export function defaultTerminal(): TerminalIO {
  return {
    input: process.stdin as unknown as TerminalInput,
    output: process.stderr as unknown as TerminalOutput,
  }
}

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

function fit(text: string, width: number): string {
  if (width <= 1 || text.length <= width) return text
  return `${text.slice(0, width - 1)}…`
}

export interface Choice<T extends string = string> {
  key: T
  label: string
}

export async function promptChoice<T extends string>(
  io: TerminalIO,
  question: string,
  choices: Choice<T>[],
  style: Style,
  fallback?: T,
): Promise<T> {
  const labels = choices
    .map((choice) => `${style.accent(`[${choice.key}]`)} ${style.value(choice.label)}`)
    .join('  ')
  io.output.write(`${question}\n  ${labels}\n`)
  const reader = new KeyReader(io.input)
  try {
    for (;;) {
      const key = await reader.next()
      if (key.ctrl && key.name === 'c') {
        const cancel = choices.find((c) => c.key === 'q') ?? choices[choices.length - 1]
        if (cancel) return cancel.key
      }
      const hit = choices.find((choice) => choice.key === key.name.toLowerCase())
      if (hit) return hit.key
      if ((key.name === 'enter' || key.name === 'escape') && fallback !== undefined) {
        return fallback
      }
    }
  } finally {
    reader.close()
  }
}

export interface SelectItem<T> {
  label: string
  hint?: string
  value: T
  selected?: boolean
}

export interface SelectOptions {
  title: string
  help?: string
  multi: boolean
  filterable?: boolean
  pageSize?: number
  emptyMessage?: string
}

interface ListState {
  cursor: number
  offset: number
  selected: Set<number>
  filter: string
  filtering: boolean
}

function visibleIndexes<T>(items: SelectItem<T>[], filter: string): number[] {
  const needle = filter.toLowerCase()
  const result: number[] = []
  items.forEach((item, index) => {
    if (needle === '' || item.label.toLowerCase().includes(needle)) result.push(index)
  })
  return result
}

function computePageSize(io: TerminalIO, requested: number | undefined): number {
  const rows = io.output.rows ?? 24
  const available = Math.max(5, rows - 6)
  return Math.max(3, Math.min(requested ?? 20, available))
}

function renderList<T>(
  io: TerminalIO,
  items: SelectItem<T>[],
  options: SelectOptions,
  state: ListState,
  style: Style,
  pageSize: number,
): string[] {
  const width = (io.output.columns ?? 100) - 1
  const visible = visibleIndexes(items, state.filter)
  const lines: string[] = [style.heading(fit(options.title, width))]
  if (options.help) lines.push(style.muted(fit(options.help, width)))
  if (options.filterable && (state.filtering || state.filter !== '')) {
    lines.push(
      `${style.accent('filter')} ${style.value(state.filter)}${state.filtering ? style.muted('▏') : ''}`,
    )
  }
  if (visible.length === 0) {
    lines.push(style.warn(options.emptyMessage ?? '  nothing matches'))
  }
  const slice = visible.slice(state.offset, state.offset + pageSize)
  slice.forEach((itemIndex, row) => {
    const item = items[itemIndex] as SelectItem<T>
    const isCursor = state.offset + row === state.cursor
    const marker = isCursor ? style.accent('❯') : ' '
    const box = options.multi
      ? `${state.selected.has(itemIndex) ? style.success('◉') : style.muted('○')} `
      : ''
    const reserved = 4 + (options.multi ? 2 : 0)
    const hint = item.hint ?? ''
    const labelRoom = Math.max(10, width - reserved - (hint ? Math.min(hint.length, 40) + 2 : 0))
    const label = fit(item.label, labelRoom)
    const text = isCursor ? style.bold(style.path(label)) : style.path(label)
    lines.push(`${marker} ${box}${text}${hint ? `  ${style.muted(fit(hint, 40))}` : ''}`)
  })
  if (visible.length > pageSize) {
    const from = state.offset + 1
    const to = Math.min(visible.length, state.offset + pageSize)
    lines.push(style.muted(`  ${from}–${to} of ${visible.length}`))
  }
  if (options.multi) {
    lines.push(style.info(`  ${state.selected.size} selected of ${items.length}`))
  }
  return lines
}

export async function runSelect<T>(
  io: TerminalIO,
  items: SelectItem<T>[],
  options: SelectOptions,
  style: Style,
): Promise<T[] | null> {
  const pageSize = computePageSize(io, options.pageSize)
  const state: ListState = {
    cursor: 0,
    offset: 0,
    selected: new Set(items.flatMap((item, i) => (item.selected ? [i] : []))),
    filter: '',
    filtering: false,
  }
  const reader = new KeyReader(io.input)
  let drawn = 0

  const draw = () => {
    const visible = visibleIndexes(items, state.filter)
    state.cursor = Math.max(0, Math.min(state.cursor, visible.length - 1))
    if (state.cursor < state.offset) state.offset = state.cursor
    if (state.cursor >= state.offset + pageSize) state.offset = state.cursor - pageSize + 1
    const lines = renderList(io, items, options, state, style, pageSize)
    const clear = drawn > 0 ? `\x1b[${drawn}A\r\x1b[J` : ''
    io.output.write(`${clear}${lines.join('\n')}\n`)
    drawn = lines.length
  }

  const erase = () => {
    if (drawn > 0) io.output.write(`\x1b[${drawn}A\r\x1b[J`)
    drawn = 0
  }

  io.output.write(HIDE_CURSOR)
  try {
    draw()
    for (;;) {
      const key = await reader.next()
      const visible = visibleIndexes(items, state.filter)
      if (key.ctrl && key.name === 'c') return finish(null)

      if (state.filtering) {
        if (key.name === 'enter') state.filtering = false
        else if (key.name === 'escape') {
          state.filtering = false
          state.filter = ''
          state.cursor = 0
          state.offset = 0
        } else if (key.name === 'backspace') {
          state.filter = state.filter.slice(0, -1)
          state.cursor = 0
          state.offset = 0
        } else if (key.ch !== undefined) {
          state.filter += key.ch
          state.cursor = 0
          state.offset = 0
        } else if (key.name === 'up') state.cursor -= 1
        else if (key.name === 'down') state.cursor += 1
        draw()
        continue
      }

      switch (key.name) {
        case 'up':
        case 'k':
          state.cursor = state.cursor <= 0 ? visible.length - 1 : state.cursor - 1
          break
        case 'down':
        case 'j':
          state.cursor = state.cursor >= visible.length - 1 ? 0 : state.cursor + 1
          break
        case 'pageup':
          state.cursor = Math.max(0, state.cursor - pageSize)
          break
        case 'pagedown':
          state.cursor = Math.min(visible.length - 1, state.cursor + pageSize)
          break
        case 'home':
          state.cursor = 0
          break
        case 'end':
          state.cursor = visible.length - 1
          break
        case 'space':
          if (options.multi) {
            const index = visible[state.cursor]
            if (index !== undefined) {
              if (state.selected.has(index)) state.selected.delete(index)
              else state.selected.add(index)
            }
            state.cursor = Math.min(visible.length - 1, state.cursor + 1)
          }
          break
        case 'a':
          if (options.multi) for (const index of visible) state.selected.add(index)
          break
        case 'n':
          if (options.multi) for (const index of visible) state.selected.delete(index)
          break
        case 'i':
          if (options.multi) {
            for (const index of visible) {
              if (state.selected.has(index)) state.selected.delete(index)
              else state.selected.add(index)
            }
          }
          break
        case '/':
          if (options.filterable) state.filtering = true
          break
        case 'enter': {
          if (options.multi) {
            const picked = [...state.selected].sort((a, b) => a - b)
            return finish(picked.map((index) => (items[index] as SelectItem<T>).value))
          }
          const index = visible[state.cursor]
          if (index === undefined) break
          return finish([(items[index] as SelectItem<T>).value])
        }
        case 'q':
        case 'escape':
          if (state.filter !== '') {
            state.filter = ''
            state.cursor = 0
            state.offset = 0
            break
          }
          return finish(null)
      }
      draw()
    }
  } finally {
    reader.close()
    io.output.write(SHOW_CURSOR)
  }

  function finish(result: T[] | null): T[] | null {
    erase()
    return result
  }
}

export async function multiSelect<T>(
  io: TerminalIO,
  items: SelectItem<T>[],
  options: Omit<SelectOptions, 'multi'>,
  style: Style,
): Promise<T[] | null> {
  return runSelect(io, items, { ...options, multi: true }, style)
}

export async function singleSelect<T>(
  io: TerminalIO,
  items: SelectItem<T>[],
  options: Omit<SelectOptions, 'multi'>,
  style: Style,
): Promise<T | null> {
  const result = await runSelect(io, items, { ...options, multi: false }, style)
  return result === null ? null : (result[0] as T)
}

export async function askText(
  io: TerminalIO,
  question: string,
  style: Style,
  initial = '',
): Promise<string | null> {
  const reader = new KeyReader(io.input)
  let value = initial
  const render = () =>
    io.output.write(`\r\x1b[K${style.accent('?')} ${question} ${style.value(value)}`)
  try {
    render()
    for (;;) {
      const key = await reader.next()
      if (key.ctrl && key.name === 'c') {
        io.output.write('\n')
        return null
      }
      if (key.name === 'escape') {
        io.output.write('\n')
        return null
      }
      if (key.name === 'enter') {
        io.output.write('\n')
        return value
      }
      if (key.name === 'backspace') value = value.slice(0, -1)
      else if (key.ch !== undefined) value += key.ch
      render()
    }
  } finally {
    reader.close()
  }
}
