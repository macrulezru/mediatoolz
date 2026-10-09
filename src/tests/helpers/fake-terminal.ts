import type { TerminalIO } from '../../utils/tty.js'

export interface FakeTerminal extends TerminalIO {
  written: string
  pending: string[]
  rawModes: boolean[]
  feed: (...chunks: string[]) => void
}

export function fakeTerminal(chunks: string[] = [], tty = true): FakeTerminal {
  let listener: ((chunk: string) => void) | null = null
  let timer: ReturnType<typeof setImmediate> | null = null
  const terminal = {
    written: '',
    pending: [...chunks],
    rawModes: [] as boolean[],
    feed(...more: string[]) {
      terminal.pending.push(...more)
      pump()
    },
    input: {
      isTTY: tty,
      setRawMode: (mode: boolean) => {
        terminal.rawModes.push(mode)
      },
      setEncoding: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: (_event: 'data', fn: (chunk: string | Buffer) => void) => {
        listener = fn as (chunk: string) => void
        pump()
      },
      off: () => {
        listener = null
        if (timer) clearImmediate(timer)
        timer = null
      },
    },
    output: {
      isTTY: tty,
      columns: 100,
      rows: 30,
      write: (text: string) => {
        terminal.written += text
      },
    },
  }
  function pump() {
    if (timer || !listener || terminal.pending.length === 0) return
    timer = setImmediate(() => {
      timer = null
      const next = terminal.pending.shift()
      if (next !== undefined && listener) listener(next)
      pump()
    })
  }
  return terminal as unknown as FakeTerminal
}
