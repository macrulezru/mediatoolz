import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fsRoutes } from './fs-routes.js'
import {
  HttpError,
  matchRoute,
  readJsonBody,
  sendBytes,
  sendJson,
  type Route,
  type UiServerOptions,
} from './http.js'
import { jobRoutes } from './jobs.js'
import { UI_MODULES } from './modules/index.js'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

export interface UiServerHandle {
  url: string
  port: number
  host: string
  token: string
  close: () => Promise<void>
}

export interface StartUiOptions {
  cwd: string
  host?: string
  port?: number
  token?: string
  staticDir?: string
  version?: string
}

export function defaultStaticDir(): string {
  const candidates = ['../../ui', '../../../dist/ui'].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  )
  return (
    candidates.find((path) => existsSync(join(path, 'index.html'))) ?? (candidates[0] as string)
  )
}

export function cookieName(port: number): string {
  return `mediatoolz-ui-${port}`
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function allRoutes(): Route[] {
  return [
    ...fsRoutes,
    ...jobRoutes,
    ...UI_MODULES.flatMap((module) => module.routes),
    {
      method: 'GET',
      path: '/api/status',
      handler: ({ res, server }) => {
        sendJson(res, 200, {
          version: server.version,
          cwd: server.cwd,
          home: homedir(),
          platform: process.platform,
          modules: UI_MODULES.map(({ id, title, description, status }) => ({
            id,
            title,
            description,
            status,
          })),
        })
      },
    },
  ]
}

function serveStatic(res: ServerResponse, staticDir: string | undefined, pathname: string): void {
  if (!staticDir || !existsSync(join(staticDir, 'index.html'))) {
    const message =
      'The mediatoolz UI is not built in this copy of the package. Run "npm run build" in the mediatoolz repository.'
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(message)
    return
  }
  const root = resolve(staticDir)
  const wanted = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
  let file = wanted
  const inside = wanted === root || wanted.startsWith(root + sep)
  if (!inside || !statSync(wanted, { throwIfNoEntry: false })?.isFile()) {
    if (extname(pathname) !== '') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    file = join(root, 'index.html')
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const cache = file.includes(`${sep}assets${sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  sendBytes(res, type, readFileSync(file), cache)
}

export async function startUiServer(options: StartUiOptions): Promise<UiServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const token = options.token ?? randomBytes(18).toString('hex')
  const routes = allRoutes()
  const state: UiServerOptions = {
    cwd: resolve(options.cwd),
    host,
    port: options.port ?? 0,
    token,
    staticDir: options.staticDir ?? defaultStaticDir(),
    version: options.version ?? '',
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end()
        return
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message })
        return
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const allowedHosts = new Set([
      `${host}:${state.port}`,
      `localhost:${state.port}`,
      `127.0.0.1:${state.port}`,
      `[::1]:${state.port}`,
    ])
    if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) {
      throw new HttpError(403, 'unexpected Host header')
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const cookie = cookieName(state.port)

    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      if (!sameToken(url.searchParams.get('token') ?? undefined, token)) {
        throw new HttpError(403, 'wrong token')
      }
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict`,
        'Cache-Control': 'no-store',
      })
      res.end()
      return
    }

    const authorized = sameToken(readCookie(req, cookie), token)
    if (url.pathname.startsWith('/api/')) {
      if (!authorized) throw new HttpError(401, 'open the address that mediatoolz ui printed')
      const origin = req.headers.origin
      if (
        origin !== undefined &&
        !allowedHosts.has(origin.replace(/^https?:\/\//, '').toLowerCase())
      ) {
        throw new HttpError(403, 'unexpected Origin header')
      }
      const found = matchRoute(routes, req.method ?? 'GET', url.pathname)
      if (!found) throw new HttpError(404, 'no such endpoint')
      await found.route.handler({
        req,
        res,
        url,
        params: found.params,
        server: state,
        readBody: () => readJsonBody(req),
      })
      return
    }

    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Open the address that "mediatoolz ui" printed in the terminal.')
      return
    }
    serveStatic(res, state.staticDir, url.pathname)
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(state.port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  state.port = (server.address() as AddressInfo).port

  return {
    url: `http://${host === '::1' ? '[::1]' : host}:${state.port}/?token=${token}`,
    port: state.port,
    host,
    token,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections()
        server.close(() => resolveClose())
      }),
  }
}
