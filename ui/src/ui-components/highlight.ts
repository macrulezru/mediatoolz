import type { HighlighterCore } from 'shiki/core'

export interface CodeToken {
  text: string
  light: string
  dark: string
  bold: boolean
  italic: boolean
}

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  md: 'markdown',
  yml: 'yaml',
}

const KNOWN = new Set([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'vue',
  'json',
  'css',
  'scss',
  'html',
  'markdown',
  'yaml',
])

let loading: Promise<HighlighterCore> | undefined

function load(): Promise<HighlighterCore> {
  loading ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ])
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/jsx.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/scss.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/markdown.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/vue.mjs'),
      ],
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return loading
}

export function plainLines(text: string): CodeToken[][] {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => [{ text: line, light: '', dark: '', bold: false, italic: false }])
}

export async function highlightLines(text: string, language: string): Promise<CodeToken[][]> {
  const lang = ALIASES[language] ?? language
  if (!KNOWN.has(lang)) return plainLines(text)
  try {
    const highlighter = await load()
    const lines = highlighter.codeToTokensWithThemes(text, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
    })
    return lines.map((line) =>
      line.map((token) => {
        const light = token.variants.light
        const dark = token.variants.dark
        const style = light?.fontStyle ?? 0
        return {
          text: token.content,
          light: light?.color ?? '',
          dark: dark?.color ?? '',
          bold: (style & 2) !== 0,
          italic: (style & 1) !== 0,
        }
      }),
    )
  } catch {
    return plainLines(text)
  }
}
