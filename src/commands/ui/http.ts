import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface UiServerOptions {
  cwd: string
  host: string
  port: number
  token: string
  staticDir: string | undefined
  version: string
}

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  server: UiServerOptions
  readBody: () => Promise<unknown>
}

export interface Route {
  method: 'GET' | 'POST'
  path: string
  handler: (ctx: RouteContext) => Promise<void> | void
}

export interface UiModule {
  id: string
  title: string
  description: string
  status: 'available' | 'planned'
  routes: Route[]
}

const MAX_BODY_BYTES = 4 * 1024 * 1024

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function sendBytes(
  res: ServerResponse,
  contentType: string,
  bytes: Uint8Array,
  cache = 'no-store',
): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': bytes.length,
    'Cache-Control': cache,
  })
  res.end(bytes)
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? ''
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'expected Content-Type: application/json')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'the request body is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'the request body is not valid JSON')
  }
}

export function asObject(value: unknown, what = 'the request body'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `${what} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

export function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue
    const want = route.path.split('/')
    const have = pathname.split('/')
    if (want.length !== have.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < want.length; i++) {
      const part = want[i] as string
      const value = have[i] as string
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(value)
      else if (part !== value) {
        ok = false
        break
      }
    }
    if (ok) return { route, params }
  }
  return undefined
}
