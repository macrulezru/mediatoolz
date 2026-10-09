import { isColorEnabled, type VibesOptions } from './vibes.js'
import { BOLD, CYAN, colorize, GREEN, RED } from './colors.js'

const RULE_CHAR = '─'
const DEFAULT_WIDTH = 70

// `unifiedDiff()` (utils/diff.ts) produces a plain, colorless string with
// git's own "Index: x / ===.../ --- x / +++ x" preamble — fine as data
// (that's what --json returns verbatim), but with several files' diffs
// printed back to back it's genuinely hard to tell where one ends and the
// next begins, and +/- lines all look the same. This renders that same
// diff for a human terminal instead: the boilerplate preamble is replaced
// with one clear, colored rule bearing the file name (and its comment/
// statement count, so it doesn't need re-reading from the list above),
// and +/- lines get their usual red/green.
export function renderDiffForHumans(
  file: string,
  count: number,
  unit: string,
  patch: string,
  options: VibesOptions = {},
): string {
  const fancy = isColorEnabled(options)

  const lines = patch.split('\n')
  const firstHunkIndex = lines.findIndex((l) => l.startsWith('@@'))
  const body = firstHunkIndex === -1 ? lines : lines.slice(firstHunkIndex)

  const width = (fancy && process.stdout.isTTY && process.stdout.columns) || DEFAULT_WIDTH

  const label = ` ${file} (${count} ${unit}) `
  const ruleWidth = Math.max(0, width - label.length - 2)
  const headerText = `${RULE_CHAR}${RULE_CHAR}${label}${RULE_CHAR.repeat(ruleWidth)}`
  const header = fancy ? colorize(BOLD + CYAN, headerText) : headerText

  const renderedBody = body.map((line) => {
    if (line.startsWith('@@')) return fancy ? colorize(CYAN, line) : line
    if (line.startsWith('+') && !line.startsWith('+++')) return fancy ? colorize(GREEN, line) : line
    if (line.startsWith('-') && !line.startsWith('---')) return fancy ? colorize(RED, line) : line
    return line
  })

  return [header, ...renderedBody].join('\n')
}
