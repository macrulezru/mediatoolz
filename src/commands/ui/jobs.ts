import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { HttpError, type Route } from './http.js'

export type JobEvent =
  | { type: 'progress'; data: unknown }
  | { type: 'done'; data: unknown }
  | { type: 'failed'; data: { message: string } }

interface Job {
  id: string
  progress: unknown
  final: JobEvent | undefined
  listeners: Set<ServerResponse>
  created: number
}

const MAX_JOBS = 50
const jobs = new Map<string, Job>()

function write(res: ServerResponse, event: JobEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return
  const finished = [...jobs.values()]
    .filter((job) => job.final !== undefined)
    .sort((a, b) => a.created - b.created)
  for (const job of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(job.id)
}

function emit(job: Job, event: JobEvent): void {
  if (event.type === 'progress') job.progress = event.data
  else job.final = event
  for (const res of job.listeners) {
    write(res, event)
    if (event.type !== 'progress') res.end()
  }
  if (event.type !== 'progress') job.listeners.clear()
}

export function startJob(task: (progress: (data: unknown) => void) => Promise<unknown>): string {
  const job: Job = {
    id: randomUUID(),
    progress: undefined,
    final: undefined,
    listeners: new Set(),
    created: Date.now(),
  }
  jobs.set(job.id, job)
  prune()
  task((data) => emit(job, { type: 'progress', data }))
    .then((data) => emit(job, { type: 'done', data }))
    .catch((error: unknown) =>
      emit(job, {
        type: 'failed',
        data: { message: error instanceof Error ? error.message : String(error) },
      }),
    )
  return job.id
}

export const jobRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/jobs/:id/events',
    handler: ({ req, res, params }) => {
      const job = jobs.get(params.id ?? '')
      if (!job) throw new HttpError(404, 'no such job')
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      if (job.progress !== undefined) write(res, { type: 'progress', data: job.progress })
      if (job.final) {
        write(res, job.final)
        res.end()
        return
      }
      job.listeners.add(res)
      req.on('close', () => job.listeners.delete(res))
    },
  },
]
