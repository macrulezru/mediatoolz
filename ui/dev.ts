import { createServer } from 'vite'
import { startUiServer } from '../src/commands/ui/server.js'

const token = process.env.MEDIATOOLZ_UI_API_TOKEN ?? 'dev'
const wantedPort = Number(process.env.MEDIATOOLZ_UI_API_PORT ?? 4477)

let api: Awaited<ReturnType<typeof startUiServer>>
try {
  api = await startUiServer({ cwd: process.cwd(), port: wantedPort, token, version: 'dev' })
} catch {
  api = await startUiServer({ cwd: process.cwd(), port: 0, token, version: 'dev' })
}

process.env.MEDIATOOLZ_UI_API_PORT = String(api.port)
process.env.MEDIATOOLZ_UI_API_TOKEN = token

const vite = await createServer({
  configFile: new URL('./vite.config.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
})
await vite.listen()

console.log(`API  http://127.0.0.1:${api.port}  (the interface proxies /api to it)`)
vite.printUrls()

async function stop(): Promise<void> {
  await vite.close()
  await api.close()
  process.exit(0)
}

process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
