import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sharp, SharpOptions } from 'sharp'
import { startUiServer, type UiServerHandle } from '../commands/ui/server.js'

const sharp = createRequire(import.meta.url)('sharp') as (
  input: unknown,
  options?: SharpOptions,
) => Sharp

let root: string
let server: UiServerHandle
let base: string
let cookie: string

async function call(path: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { cookie, ...(init.headers as Record<string, string> | undefined), ...headers },
  })
}

async function post(path: string, body: unknown) {
  return call(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function waitForJob(jobId: string): Promise<{ type: string; data: Record<string, unknown> }> {
  const response = await call(`/api/jobs/${jobId}/events`)
  const text = await response.text()
  const events = text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const type = /^event: (.*)$/m.exec(block)?.[1] ?? ''
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as Record<string, unknown>
      return { type, data }
    })
  return events[events.length - 1] as { type: string; data: Record<string, unknown> }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ui-server-'))
  mkdirSync(join(root, 'photos', 'sub'), { recursive: true })
  mkdirSync(join(root, 'static'), { recursive: true })
  writeFileSync(join(root, 'static', 'index.html'), '<!doctype html><title>x</title>')
  for (const name of ['a.png', 'sub/b.png']) {
    await sharp(Buffer.alloc(40 * 30 * 3, 120), { raw: { width: 40, height: 30, channels: 3 } })
      .png()
      .toFile(join(root, 'photos', name))
  }
  writeFileSync(join(root, 'photos', 'notes.txt'), 'x')
  server = await startUiServer({
    cwd: root,
    token: 'secret',
    staticDir: join(root, 'static'),
    version: '9.9.9',
  })
  base = `http://127.0.0.1:${server.port}`
  cookie = `mediatoolz-ui-${server.port}=secret`
})

afterEach(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('mediatoolz ui server', { timeout: 60_000 }, () => {
  it('listens on this machine only and prints an address with the token', () => {
    expect(server.host).toBe('127.0.0.1')
    expect(server.url).toBe(`${base}/?token=secret`)
  })

  it('sets the cookie for the right token and refuses a wrong one', async () => {
    const good = await fetch(`${base}/?token=secret`, { redirect: 'manual' })
    expect(good.status).toBe(302)
    expect(good.headers.get('set-cookie')).toContain(`mediatoolz-ui-${server.port}=secret`)
    expect(good.headers.get('set-cookie')).toContain('HttpOnly')
    expect(good.headers.get('set-cookie')).toContain('SameSite=Strict')
    const bad = await fetch(`${base}/?token=nope`, { redirect: 'manual' })
    expect(bad.status).toBe(403)
  })

  it('needs the cookie for the pages and for every endpoint', async () => {
    expect((await fetch(`${base}/`)).status).toBe(401)
    expect((await fetch(`${base}/api/status`)).status).toBe(401)
    const page = await call('/')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>x</title>')
  })

  it('rejects a foreign Host and a foreign Origin', async () => {
    const host = await new Promise<number>((resolveStatus) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/status',
          headers: { cookie, Host: 'evil.example' },
        },
        (response) => {
          response.resume()
          resolveStatus(response.statusCode ?? 0)
        },
      )
      request.end()
    })
    expect(host).toBe(403)
    const origin = await call('/api/status', {}, { Origin: 'http://evil.example' })
    expect(origin.status).toBe(403)
  })

  it('reports the version, the folder and the modules', async () => {
    const status = (await (await call('/api/status')).json()) as {
      version: string
      cwd: string
      modules: { id: string; status: string }[]
    }
    expect(status.version).toBe('9.9.9')
    expect(status.cwd).toBe(root)
    expect(status.modules).toEqual([
      expect.objectContaining({ id: 'image-hash', status: 'available' }),
      expect.objectContaining({ id: 'image-batch', status: 'available' }),
    ])
  })

  it('lists folders and images only, folders first', async () => {
    const listing = (await (
      await call(`/api/fs/list?path=${encodeURIComponent(join(root, 'photos'))}`)
    ).json()) as { entries: { name: string; kind: string }[]; parent: string }
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'dir:sub',
      'image:a.png',
    ])
    expect(listing.parent).toBe(root)
    expect((await call('/api/fs/list?path=nowhere')).status).toBe(404)
  })

  it('serves a thumbnail of an image and nothing else', async () => {
    const path = encodeURIComponent(join(root, 'photos', 'a.png'))
    const thumb = await call(`/api/fs/image?path=${path}&size=20`)
    expect(thumb.status).toBe(200)
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()
    expect(meta.width).toBeLessThanOrEqual(20)
    const text = await call(
      `/api/fs/image?path=${encodeURIComponent(join(root, 'photos', 'notes.txt'))}`,
    )
    expect(text.status).toBe(400)
  })

  it('counts the images, folders and bytes of the added sources', async () => {
    const scan = async (body: unknown) =>
      (await (await post('/api/image-hash/scan', body)).json()) as {
        sources: { path: string; kind: string; files: number; folders: number; bytes: number }[]
        total: { files: number; folders: number; bytes: number }
      }
    const folder = join(root, 'photos')
    const deep = await scan({ paths: [folder], recursive: true })
    expect(deep.total).toMatchObject({ files: 2, folders: 2 })
    expect(deep.total.bytes).toBeGreaterThan(0)
    expect(deep.sources[0]).toMatchObject({ kind: 'folder', files: 2, folders: 2 })
    const flat = await scan({ paths: [folder], recursive: false })
    expect(flat.total).toMatchObject({ files: 1, folders: 1 })
    const mixed = await scan({
      paths: [folder, join(folder, 'a.png'), join(root, 'missing')],
      recursive: true,
    })
    expect(mixed.total.files).toBe(2)
    expect(mixed.sources.map((source) => source.kind)).toEqual(['folder', 'file', 'missing'])
    expect(mixed.sources[1]).toMatchObject({ files: 1, folders: 1 })
  })

  it('computes hashes as a job and returns the entries and the output', async () => {
    const started = await post('/api/image-hash/run', {
      paths: [join(root, 'photos')],
      recursive: true,
      types: ['blurhash', 'color'],
      format: 'json',
    })
    expect(started.status).toBe(202)
    const { jobId } = (await started.json()) as { jobId: string }
    const last = await waitForJob(jobId)
    expect(last.type).toBe('done')
    const data = last.data as {
      entries: { file: string; path: string; blurhash?: string; color?: string }[]
      output: string
      errors: unknown[]
    }
    expect(data.entries.map((entry) => entry.file)).toEqual(['a.png', 'sub/b.png'])
    expect(data.entries[0]?.blurhash).toBeTruthy()
    expect(data.entries[0]?.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(data.entries[0]?.path).toBe(join(root, 'photos', 'a.png'))
    expect(JSON.parse(data.output)['a.png']).toBeTruthy()
    expect(data.errors).toEqual([])
  })

  it('refuses a bad request with a message instead of starting a job', async () => {
    const none = await post('/api/image-hash/run', { paths: [], types: ['blurhash'] })
    expect(none.status).toBe(400)
    const type = await post('/api/image-hash/run', { paths: ['x'], types: ['md5'] })
    expect(type.status).toBe(400)
    expect(((await type.json()) as { error: string }).error).toContain('--type')
    const budget = await post('/api/image-hash/run', {
      paths: ['x'],
      types: ['hazehash'],
      budget: 3,
    })
    expect(budget.status).toBe(400)
    const form = await call('/api/image-hash/run', { method: 'POST', body: '{}' })
    expect(form.status).toBe(415)
  })

  it('writes the output to a file, and asks before replacing one', async () => {
    const path = join(root, 'out', 'hashes.json')
    const first = await post('/api/image-hash/save', { path, content: '{"a":1}' })
    expect(first.status).toBe(200)
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}')
    const again = await post('/api/image-hash/save', { path, content: '{"a":2}' })
    expect(again.status).toBe(409)
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}')
    const forced = await post('/api/image-hash/save', { path, content: '{"a":2}', overwrite: true })
    expect(forced.status).toBe(200)
    expect(readFileSync(path, 'utf8')).toBe('{"a":2}')
  })

  it('says how to build the UI when the static files are missing', async () => {
    const lonely = await startUiServer({ cwd: root, token: 't', staticDir: join(root, 'missing') })
    try {
      const response = await fetch(`http://127.0.0.1:${lonely.port}/`, {
        headers: { cookie: `mediatoolz-ui-${lonely.port}=t` },
      })
      expect(response.status).toBe(503)
      expect(await response.text()).toContain('npm run build')
    } finally {
      await lonely.close()
    }
  })

  it('does not serve files outside the static folder', async () => {
    const response = await call('/..%2f..%2fstatic%2findex.html')
    expect([200, 404]).toContain(response.status)
    const escape = await call('/../package.json')
    expect(await escape.text()).not.toContain('"name"')
  })
})

describe('mediatoolz ui image-batch module', { timeout: 120_000 }, () => {
  type Report = {
    dryRun: boolean
    counts: Record<string, number>
    results: {
      source: string
      sourceAbs: string
      output: string
      outputAbs: string
      status: string
      width: number
      bytes?: number
      before?: number
    }[]
  }

  const run = async (body: Record<string, unknown>) => {
    const started = await post('/api/image-batch/run', {
      paths: [join(root, 'photos')],
      recursive: true,
      ...body,
    })
    if (started.status !== 202)
      return { status: started.status, error: (await started.json()) as { error: string } }
    const { jobId } = (await started.json()) as { jobId: string }
    const last = await waitForJob(jobId)
    return { status: 202, last }
  }

  it('describes what the interface can offer', async () => {
    const options = (await (await call('/api/image-batch/options')).json()) as {
      formats: string[]
      sizeMethods: string[]
      placements: string[]
      sharpen: { targets: string[]; builtIn: string[] }
      defaultTemplates: Record<string, string>
      templateVariables: string[]
    }
    expect(options.formats).toContain('webp')
    expect(options.formats).toContain('original')
    expect(options.sizeMethods).toEqual(
      expect.arrayContaining(['widths', 'size', 'longEdge', 'megapixels', 'percent', 'original']),
    )
    expect(options.placements).toEqual(['out', 'beside', 'replace'])
    expect(options.sharpen.builtIn).toContain('web-crisp')
    expect(options.defaultTemplates.widths).toBe('{dir}/{name}-{width}w.{format}')
    expect(options.templateVariables).toContain('width')
  })

  it('lists the saved configs and the sharpen presets', async () => {
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, '.mediatoolz', 'image-batch', 'sharpen'), { recursive: true })
    writeFileSync(
      join(root, '.mediatoolz', 'image-batch', 'web.json'),
      JSON.stringify({ name: 'Web', outputs: [{ widths: [20], formats: ['png'] }] }),
    )
    writeFileSync(
      join(root, '.mediatoolz', 'image-batch', 'sharpen', 'mine.json'),
      JSON.stringify({ for: 'matte', radius: 1.1 }),
    )
    const configs = (await (await call('/api/image-batch/configs')).json()) as {
      name: string
      scope: string
      recipes: number
    }[]
    expect(configs.find((row) => row.name === 'web')).toMatchObject({
      scope: 'project',
      recipes: 1,
    })
    const presets = (await (await call('/api/image-batch/sharpen-presets')).json()) as {
      name: string
      scope: string
      params?: { sigma: number }
    }[]
    expect(presets.find((row) => row.name === 'mine')).toMatchObject({ scope: 'project' })
    expect(presets.find((row) => row.name === 'mine')?.params?.sigma).toBe(1.1)
    expect(presets.find((row) => row.name === 'web-crisp')?.scope).toBe('built-in')
  })

  it('counts what it would convert, then converts, with real paths in the result', async () => {
    const out = join(root, 'result')
    const plan = await run({
      placement: 'out',
      out,
      dryRun: true,
      settings: { sizeMethod: 'widths', values: [20], formats: ['webp'] },
    })
    expect(plan.last?.type).toBe('done')
    const dry = plan.last?.data as unknown as Report
    expect(dry.dryRun).toBe(true)
    expect(dry.counts['would-write']).toBe(2)
    expect(existsSync(out)).toBe(false)

    const done = await run({
      placement: 'out',
      out,
      settings: { sizeMethod: 'widths', values: [20], formats: ['webp'] },
    })
    const report = done.last?.data as unknown as Report
    expect(report.counts.written).toBe(2)
    const first = report.results.find((row) => row.source === 'a.png')
    expect(first?.sourceAbs).toBe(join(root, 'photos', 'a.png'))
    expect(first?.outputAbs).toBe(join(out, 'a-20w.webp'))
    expect(existsSync(join(out, 'sub', 'b-20w.webp'))).toBe(true)
    expect((await sharp(join(out, 'a-20w.webp')).metadata()).width).toBe(20)
  })

  it('applies a saved config by name', async () => {
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, '.mediatoolz', 'image-batch'), { recursive: true })
    writeFileSync(
      join(root, '.mediatoolz', 'image-batch', 'tiny.json'),
      JSON.stringify({ outputs: [{ widths: [10], formats: ['png'], name: 'x/{name}.{format}' }] }),
    )
    const out = join(root, 'by-config')
    const done = await run({ placement: 'out', out, config: 'tiny' })
    expect((done.last?.data as unknown as Report).counts.written).toBe(2)
    expect(existsSync(join(out, 'x', 'a.png'))).toBe(true)
  })

  it('sizes by a box, sharpens with a preset and caps the file size', async () => {
    mkdirSync(join(root, '.git'), { recursive: true })
    const out = join(root, 'boxed')
    const done = await run({
      placement: 'out',
      out,
      settings: {
        sizeMethod: 'size',
        box: '20x20',
        fit: 'inside',
        formats: ['jpg'],
        quality: 'medium',
        maxBytes: '2KB',
        sharpen: { preset: 'web-crisp' },
      },
    })
    expect(done.last?.type).toBe('done')
    const report = done.last?.data as unknown as Report
    expect(report.counts.written).toBe(2)
    expect(report.results.every((row) => (row.bytes ?? 0) <= 2048)).toBe(true)
  })

  it('writes next to the originals and replaces them with a backup', async () => {
    const beside = await run({
      placement: 'beside',
      settings: { sizeMethod: 'widths', values: [16], formats: ['png'] },
    })
    expect((beside.last?.data as unknown as Report).counts.written).toBe(2)
    expect(existsSync(join(root, 'photos', 'a-16w.png'))).toBe(true)

    const copy = join(root, 'replace-me')
    mkdirSync(copy, { recursive: true })
    await sharp(Buffer.alloc(120 * 90 * 3, 90), { raw: { width: 120, height: 90, channels: 3 } })
      .png()
      .toFile(join(copy, 'big.png'))
    const replaced = await run({
      paths: [copy],
      placement: 'replace',
      settings: { sizeMethod: 'widths', values: [30] },
    })
    const report = replaced.last?.data as unknown as Report & { backupDir?: string }
    expect(report.counts.replaced).toBe(1)
    expect((await sharp(join(copy, 'big.png')).metadata()).width).toBe(30)
    expect(report.backupDir).toBeTruthy()
  })

  it('asks for a folder when results go to a folder, and rejects wrong values', async () => {
    const noOut = await run({ placement: 'out', settings: { sizeMethod: 'widths', values: [20] } })
    expect(noOut.status).toBe(400)
    const widths = await run({
      placement: 'out',
      out: join(root, 'o'),
      settings: { sizeMethod: 'widths', values: [0] },
    })
    expect(widths.status).toBe(400)
    expect(widths.error?.error).toContain('widths')
    const format = await run({
      placement: 'out',
      out: join(root, 'o'),
      settings: { sizeMethod: 'original', formats: ['bmp'] },
    })
    expect(format.status).toBe(400)
    const sharpen = await run({
      placement: 'out',
      out: join(root, 'o'),
      settings: { sizeMethod: 'original', sharpen: { radius: 99 } },
    })
    expect(sharpen.status).toBe(400)
    expect(sharpen.error?.error).toContain('radius')
    const place = await run({ placement: 'sideways' })
    expect(place.status).toBe(400)
  })

  it('reports a missing sharpen preset and config as a failed job or a bad request', async () => {
    const preset = await run({
      placement: 'out',
      out: join(root, 'o'),
      settings: { sizeMethod: 'original', sharpen: { preset: 'nope' } },
    })
    expect(preset.last?.type).toBe('failed')
    expect(JSON.stringify(preset.last?.data)).toContain('no sharpen preset named')
    const config = await run({ placement: 'out', out: join(root, 'o'), config: 'ghost' })
    expect(config.status).toBe(400)
    expect(config.error?.error).toContain('no config named')
  })

  it('counts images for the scan, svg included', async () => {
    writeFileSync(join(root, 'photos', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const scan = (await (
      await post('/api/image-batch/scan', { paths: [join(root, 'photos')], recursive: false })
    ).json()) as { total: { files: number } }
    expect(scan.total.files).toBe(2)
  })
})

describe('mediatoolz ui configs and sharpen presets', { timeout: 120_000 }, () => {
  const configPath = (name: string) => join(root, '.mediatoolz', 'image-batch', `${name}.json`)
  const presetPath = (name: string) =>
    join(root, '.mediatoolz', 'image-batch', 'sharpen', `${name}.json`)
  const raw = { name: 'Web', outputs: [{ id: 'a', widths: [20], formats: ['webp'] }] }

  const save = (body: Record<string, unknown>) => post('/api/image-batch/config/save', body)

  beforeEach(() => mkdirSync(join(root, '.git'), { recursive: true }))

  it('validates a config and describes what it produces', async () => {
    const good = (await (await post('/api/image-batch/config/validate', { raw })).json()) as {
      ok: boolean
      lines: string[]
    }
    expect(good.ok).toBe(true)
    expect(good.lines.join('\n')).toContain('widths 20')
    const bad = (await (
      await post('/api/image-batch/config/validate', {
        raw: { outputs: [{ widths: [0], formats: ['webp'] }] },
      })
    ).json()) as { ok: boolean; error: string }
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('widths')
    const missing = (await (
      await post('/api/image-batch/config/validate', {
        raw: { outputs: [{ widths: [20], sharpen: 'nope' }] },
      })
    ).json()) as { ok: boolean; error: string }
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('no sharpen preset named')
  })

  it('creates, reads, renames, and deletes a config, keeping a backup', async () => {
    expect((await save({ name: 'web', scope: 'project', raw })).status).toBe(200)
    expect(JSON.parse(readFileSync(configPath('web'), 'utf8')).name).toBe('Web')
    const read = (await (await call('/api/image-batch/config?name=web&scope=project')).json()) as {
      raw: { outputs: unknown[] }
    }
    expect(read.raw.outputs).toHaveLength(1)

    const again = await save({ name: 'web', scope: 'project', raw })
    expect(again.status).toBe(409)
    const same = await save({
      name: 'web',
      scope: 'project',
      raw: { ...raw, name: 'Web 2' },
      originalName: 'web',
      originalScope: 'project',
    })
    expect(same.status).toBe(200)

    const renamed = await save({
      name: 'site',
      scope: 'project',
      raw,
      originalName: 'web',
      originalScope: 'project',
    })
    expect(renamed.status).toBe(200)
    expect(existsSync(configPath('web'))).toBe(false)
    expect(existsSync(configPath('site'))).toBe(true)

    const removed = await post('/api/image-batch/config/delete', { name: 'site', scope: 'project' })
    expect(removed.status).toBe(200)
    expect(existsSync(configPath('site'))).toBe(false)
    expect(existsSync(`${configPath('site')}.bak`)).toBe(true)
    const ghost = await post('/api/image-batch/config/delete', { name: 'site', scope: 'project' })
    expect(ghost.status).toBe(404)
  })

  it('refuses to save an invalid config or a bad name', async () => {
    const invalid = await save({
      name: 'x',
      scope: 'project',
      raw: { outputs: [{ widths: [0] }] },
    })
    expect(invalid.status).toBe(400)
    expect(existsSync(configPath('x'))).toBe(false)
    const badName = await save({ name: '../escape', scope: 'project', raw })
    expect(badName.status).toBe(400)
    const scope = await save({ name: 'x', scope: 'nowhere', raw })
    expect(scope.status).toBe(400)
  })

  it('creates, edits and deletes a sharpen preset, and checks it', async () => {
    const make = (body: Record<string, unknown>) =>
      post('/api/image-batch/sharpen-preset/save', body)
    const created = await make({
      name: 'crisp',
      scope: 'project',
      description: 'for the web',
      fields: { for: 'glossy', radius: 1.2 },
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(readFileSync(presetPath('crisp'), 'utf8'))).toEqual({
      description: 'for the web',
      for: 'glossy',
      radius: 1.2,
    })
    const bad = await make({ name: 'bad', scope: 'project', fields: { radius: 99 } })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('radius')
    expect((await make({ name: 'crisp', scope: 'project', fields: { for: 'matte' } })).status).toBe(
      409,
    )
    const renamed = await make({
      name: 'sharp-2',
      scope: 'project',
      fields: { for: 'matte' },
      originalName: 'crisp',
      originalScope: 'project',
    })
    expect(renamed.status).toBe(200)
    expect(existsSync(presetPath('crisp'))).toBe(false)

    const params = (await (
      await post('/api/image-batch/sharpen-preset/params', {
        fields: { for: 'matte', amount: 'high' },
      })
    ).json()) as { params: { sigma: number; m2: number } }
    expect(params.params).toMatchObject({ sigma: 1, m2: 5 })

    const builtIn = await post('/api/image-batch/sharpen-preset/delete', {
      name: 'web-crisp',
      scope: 'project',
    })
    expect(builtIn.status).toBe(404)
    const removed = await post('/api/image-batch/sharpen-preset/delete', {
      name: 'sharp-2',
      scope: 'project',
    })
    expect(removed.status).toBe(200)
    expect(existsSync(`${presetPath('sharp-2')}.bak`)).toBe(true)
  })

  it('renders a sharpening preview that differs from the plain one', async () => {
    const path = join(root, 'photos', 'a.png')
    await sharp(Buffer.from(Array.from({ length: 64 * 64 * 3 }, (_, i) => (i * 37) % 251)), {
      raw: { width: 64, height: 64, channels: 3 },
    })
      .png()
      .toFile(path)
    const plain = Buffer.from(
      await (
        await call(`/api/image-batch/sharpen-preview?path=${encodeURIComponent(path)}&width=64`)
      ).arrayBuffer(),
    )
    const sharpened = Buffer.from(
      await (
        await call(
          `/api/image-batch/sharpen-preview?path=${encodeURIComponent(path)}&width=64&sharpen=1&for=glossy&amount=high`,
        )
      ).arrayBuffer(),
    )
    expect((await sharp(plain).metadata()).width).toBe(64)
    expect(plain.equals(sharpened)).toBe(false)
    const wrong = await call(
      `/api/image-batch/sharpen-preview?path=${encodeURIComponent(path)}&sharpen=1&radius=99`,
    )
    expect(wrong.status).toBe(400)
  })
})

describe('mediatoolz ui backups', { timeout: 120_000 }, () => {
  const replaceOne = async () => {
    const copy = join(root, 'replace-me')
    mkdirSync(copy, { recursive: true })
    await sharp(Buffer.alloc(120 * 90 * 3, 90), { raw: { width: 120, height: 90, channels: 3 } })
      .png()
      .toFile(join(copy, 'big.png'))
    const started = await post('/api/image-batch/run', {
      paths: [copy],
      placement: 'replace',
      settings: { sizeMethod: 'widths', values: [30] },
    })
    const { jobId } = (await started.json()) as { jobId: string }
    const last = await waitForJob(jobId)
    return { copy, backupDir: (last.data as { backupDir: string }).backupDir }
  }

  it('lists the backups that replacing made, newest first', async () => {
    const empty = (await (await call('/api/image-batch/backups')).json()) as { backups: unknown[] }
    expect(empty.backups).toEqual([])
    const { backupDir } = await replaceOne()
    const listed = (await (await call('/api/image-batch/backups')).json()) as {
      root: string
      backups: { dir: string; files: number; bytesBefore: number; bytesAfter: number }[]
    }
    expect(listed.backups).toHaveLength(1)
    expect(listed.backups[0]).toMatchObject({ dir: backupDir, files: 1 })
    expect(listed.backups[0]?.bytesAfter).toBeLessThan(listed.backups[0]?.bytesBefore ?? 0)
  })

  it('shows what a restore would do, restores, and notices later changes', async () => {
    const { copy, backupDir } = await replaceOne()
    const detail = (await (
      await call(`/api/image-batch/backup?dir=${encodeURIComponent(backupDir)}`)
    ).json()) as {
      counts: Record<string, number>
      entries: { path: string; backup: string; status: string }[]
    }
    expect(detail.counts['would-restore']).toBe(1)
    expect(detail.entries[0]).toMatchObject({
      path: join(copy, 'big.png'),
      status: 'would-restore',
    })
    expect((await sharp(join(copy, 'big.png')).metadata()).width).toBe(30)

    const restored = (await (
      await post('/api/image-batch/backup/restore', { dir: backupDir })
    ).json()) as {
      counts: Record<string, number>
    }
    expect(restored.counts.restored).toBe(1)
    expect((await sharp(join(copy, 'big.png')).metadata()).width).toBe(120)

    const afterRestore = (await (
      await call(`/api/image-batch/backup?dir=${encodeURIComponent(backupDir)}`)
    ).json()) as { counts: Record<string, number> }
    expect(afterRestore.counts.modified).toBe(0)
    expect(afterRestore.counts.restored).toBe(1)

    await sharp(Buffer.alloc(50 * 50 * 3, 10), { raw: { width: 50, height: 50, channels: 3 } })
      .png()
      .toFile(join(copy, 'big.png'))
    const changed = (await (
      await call(`/api/image-batch/backup?dir=${encodeURIComponent(backupDir)}`)
    ).json()) as { counts: Record<string, number> }
    expect(changed.counts.modified).toBe(1)
    const refused = (await (
      await post('/api/image-batch/backup/restore', { dir: backupDir })
    ).json()) as {
      counts: Record<string, number>
    }
    expect(refused.counts.modified).toBe(1)
    expect((await sharp(join(copy, 'big.png')).metadata()).width).toBe(50)
    const forced = (await (
      await post('/api/image-batch/backup/restore', { dir: backupDir, force: true })
    ).json()) as { counts: Record<string, number> }
    expect(forced.counts.restored).toBe(1)
    expect((await sharp(join(copy, 'big.png')).metadata()).width).toBe(120)
  })

  it('deletes a backup, and refuses a folder that is not one', async () => {
    const { backupDir } = await replaceOne()
    const notBackup = await post('/api/image-batch/backup/delete', { dir: join(root, 'photos') })
    expect(notBackup.status).toBe(400)
    expect(existsSync(join(root, 'photos'))).toBe(true)
    const removed = await post('/api/image-batch/backup/delete', { dir: backupDir })
    expect(removed.status).toBe(200)
    expect(existsSync(backupDir)).toBe(false)
    expect((await post('/api/image-batch/backup/delete', { dir: backupDir })).status).toBe(404)
    const missing = await call('/api/image-batch/backup?dir=')
    expect(missing.status).toBe(400)
  })
})
