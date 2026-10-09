import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const apiPort = process.env.MEDIATOOLZ_UI_API_PORT ?? '4477'
const apiToken = process.env.MEDIATOOLZ_UI_API_TOKEN ?? 'dev'

const stylesDir = fileURLToPath(new URL('./src/styles', import.meta.url))
const sharedScss = "@use 'variables' as *;\n@use 'mixins' as *;\n"

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  css: {
    preprocessorOptions: {
      scss: {
        loadPaths: [stylesDir],
        additionalData: (source: string, filename: string) =>
          filename.endsWith('style.scss') ? source : sharedScss + source,
      },
    },
  },
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            request.setHeader('cookie', `mediatoolz-ui-${apiPort}=${apiToken}`)
            request.setHeader('origin', `http://127.0.0.1:${apiPort}`)
          })
        },
      },
    },
  },
})
