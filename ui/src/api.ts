export class ApiError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>

  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let data: Record<string, unknown> = {}
  try {
    data = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  } catch {
    data = { error: text }
  }
  if (!response.ok) {
    const message =
      typeof data.error === 'string' ? data.error : `The request failed (${response.status})`
    throw new ApiError(response.status, message, data)
  }
  return data as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown) => request<T>('POST', url, body),
}

export interface ModuleInfo {
  id: string
  title: string
  description: string
  status: 'available' | 'planned'
}

export interface StatusInfo {
  version: string
  cwd: string
  home: string
  platform: string
  modules: ModuleInfo[]
}

export interface FsEntry {
  name: string
  kind: 'dir' | 'image'
  size?: number
}

export interface FsListing {
  path: string
  parent: string | null
  home: string
  cwd: string
  root: string
  roots: string[]
  entries: FsEntry[]
  truncated: boolean
}

export function imageUrl(path: string, size: number): string {
  return `/api/fs/image?path=${encodeURIComponent(path)}&size=${size}`
}

export interface JobHandlers<P, R> {
  onProgress?: (data: P) => void
  onDone: (data: R) => void
  onFailed: (message: string) => void
}

export function watchJob<P, R>(jobId: string, handlers: JobHandlers<P, R>): () => void {
  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`)
  let finished = false
  const finish = () => {
    finished = true
    source.close()
  }
  source.addEventListener('progress', (event) => {
    handlers.onProgress?.(JSON.parse((event as MessageEvent<string>).data) as P)
  })
  source.addEventListener('done', (event) => {
    finish()
    handlers.onDone(JSON.parse((event as MessageEvent<string>).data) as R)
  })
  source.addEventListener('failed', (event) => {
    finish()
    handlers.onFailed(
      (JSON.parse((event as MessageEvent<string>).data) as { message: string }).message,
    )
  })
  source.onerror = () => {
    if (finished) return
    finish()
    handlers.onFailed('The connection to mediatoolz ui was lost.')
  }
  return finish
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
