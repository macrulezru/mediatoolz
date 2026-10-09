import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { createStyle } from '../../format/style.js'
import { openBrowser } from './open-browser.js'
import { startUiServer } from './server.js'

interface UiCliOptions {
  cwd: string
  port: string
  host: string
  open: boolean
  token?: string
  plain: boolean
  color: boolean
}

function packageVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? ''
  } catch {
    return ''
  }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a whole number from 0 to 65535 (got "${value}")`)
  }
  return port
}

export function registerUi(program: Command): void {
  program
    .command('ui')
    .description(
      'Start a local web interface for mediatoolz modules (image-hash first) and open it in the browser',
    )
    .option('--port <n>', 'port to listen on (0 = pick a free one)', '0')
    .option(
      '--host <address>',
      'address to listen on; keep the default to stay on this machine',
      '127.0.0.1',
    )
    .option('--no-open', 'do not open the browser, only print the address')
    .option('--token <value>', 'use this access token instead of a random one (for development)')
    .option('--cwd <path>', 'folder the interface starts in', process.cwd())
    .option('--plain', 'disable color/banner/celebration copy, even in a real terminal', false)
    .option('--color', 'force colored output even when piped or in CI', false)
    .action(async (options: UiCliOptions) => {
      const style = createStyle({ plain: options.plain, color: options.color })
      let port: number
      try {
        port = parsePort(options.port)
      } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 2
        return
      }
      let handle: Awaited<ReturnType<typeof startUiServer>>
      try {
        handle = await startUiServer({
          cwd: resolve(options.cwd),
          host: options.host,
          port,
          ...(options.token !== undefined ? { token: options.token } : {}),
          version: packageVersion(),
        })
      } catch (error) {
        const code = (error as { code?: string }).code
        console.error(
          code === 'EADDRINUSE'
            ? `error: port ${port} is already in use — pick another with --port, or leave it out`
            : `error: ${error instanceof Error ? error.message : String(error)}`,
        )
        process.exitCode = 1
        return
      }
      console.log(`${style.success('mediatoolz ui')} is running at ${style.path(handle.url)}`)
      console.log(style.hint('Press Ctrl+C to stop.'))
      if (options.open) {
        if (!openBrowser(handle.url)) {
          console.log(style.warn('Could not open the browser — open the address above yourself.'))
        }
      }
      await new Promise<void>((done) => {
        const stop = () => {
          void handle.close().then(done)
        }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      })
    })
}
