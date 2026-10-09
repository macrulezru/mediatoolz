const SPECIAL = /[.+^$()|\\]/g

function convert(pattern: string): string {
  let out = ''
  let i = 0
  let braceDepth = 0
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      out += '[^/]'
      i += 1
    } else if (ch === '{') {
      braceDepth += 1
      out += '(?:'
      i += 1
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth -= 1
      out += ')'
      i += 1
    } else if (ch === ',' && braceDepth > 0) {
      out += '|'
      i += 1
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) {
        out += '\\['
        i += 1
      } else {
        const body = pattern.slice(i + 1, end).replace(/^!/, '^')
        out += `[${body}]`
        i = end + 1
      }
    } else {
      out += ch.replace(SPECIAL, '\\$&')
      i += 1
    }
  }
  return out
}

export function hasGlobChars(text: string): boolean {
  return /[*?[\]{}]/.test(text)
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePattern(pattern)
  const body = convert(normalized)
  const anywhere = normalized.includes('/') ? '' : '(?:.*/)?'
  return new RegExp(`^${anywhere}${body}$`, 'i')
}

export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path.replace(/\\/g, '/'))
}

export function literalPrefix(pattern: string): string {
  const segments = pattern.replace(/\\/g, '/').split('/')
  const literal: string[] = []
  for (const segment of segments) {
    if (hasGlobChars(segment)) break
    literal.push(segment)
  }
  return literal.join('/')
}
