import { BOLD, CYAN, DIM, GRAY, GREEN, MAGENTA, RED, WHITE, YELLOW, colorize } from './colors.js'
import { isColorEnabled, type VibesOptions } from './vibes.js'

export interface Style {
  enabled: boolean
  info(text: string): string
  problem(text: string): string
  heading(text: string): string
  success(text: string): string
  warn(text: string): string
  error(text: string): string
  hint(text: string): string
  path(text: string): string
  location(text: string): string
  name(text: string): string
  tag(text: string): string
  muted(text: string): string
  accent(text: string): string
  value(text: string): string
  bold(text: string): string
}

const FLAG_PATTERN = /(?<![\w-])(--?[a-zA-Z][\w-]*)/g
const LOCATION_PATTERN = /^(.*?)((?::\d+)+)(\s*)$/

export function createStyle(options: VibesOptions = {}): Style {
  const enabled = isColorEnabled(options)
  const wrap = (color: string, text: string) => (enabled && text ? colorize(color, text) : text)

  return {
    enabled,
    info: (text) => wrap(GRAY, text),
    problem: (text) => wrap(BOLD + RED, text),
    heading: (text) => wrap(BOLD + YELLOW, text),
    success: (text) => wrap(BOLD + GREEN, text),
    warn: (text) => wrap(YELLOW, text),
    error: (text) => wrap(RED, text),
    hint: (text) =>
      enabled
        ? colorize(DIM, text).replace(FLAG_PATTERN, (flag) => `\x1b[0m${CYAN}${flag}\x1b[0m${DIM}`)
        : text,
    path: (text) => wrap(CYAN, text),
    location: (text) => {
      if (!enabled) return text
      const match = LOCATION_PATTERN.exec(text)
      if (!match) return colorize(CYAN, text)
      return `${colorize(CYAN, match[1] as string)}${colorize(GRAY, match[2] as string)}${match[3]}`
    },
    name: (text) => wrap(YELLOW, text),
    tag: (text) => wrap(GRAY, text),
    muted: (text) => wrap(DIM, text),
    accent: (text) => wrap(MAGENTA, text),
    value: (text) => wrap(WHITE, text),
    bold: (text) => wrap(BOLD, text),
  }
}
