import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { ProxyOptions } from 'vite'
import { resolve } from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

function createProxyConfig(): ProxyOptions {
  return {
    target: 'http://127.0.0.1:8642',
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
      // Disable response buffering for SSE streaming
      proxy.on('proxyRes', (proxyRes) => {
        proxyRes.headers['cache-control'] = 'no-cache'
        proxyRes.headers['x-accel-buffering'] = 'no'
      })
    },
  }
}

const UPLOAD_DIR = resolve(tmpdir(), 'hermes-uploads')

async function handleUpload(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  const contentType = req.headers['content-type'] || ''
  if (!contentType.startsWith('multipart/form-data')) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Expected multipart/form-data' }))
    return
  }

  try {
    await mkdir(UPLOAD_DIR, { recursive: true })
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()

    const boundary = '--' + contentType.split('boundary=')[1]
    const parts = body.split(boundary).slice(1, -1)

    const results: { name: string; path: string }[] = []
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n')
      if (headerEnd === -1) continue
      const header = part.substring(0, headerEnd)
      const data = part.substring(headerEnd + 4, part.length - 2)

      const filenameMatch = header.match(/filename="([^"]+)"/)
      if (!filenameMatch) continue

      const filename = filenameMatch[1]
      const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
      const savedName = randomBytes(8).toString('hex') + ext
      const savedPath = resolve(UPLOAD_DIR, savedName)

      await writeFile(savedPath, Buffer.from(data, 'binary'))
      results.push({ name: filename, path: savedPath })
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ files: results }))
  } catch (err: any) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'upload-middleware',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/__upload')) {
            handleUpload(req as any, res as any)
          } else {
            next()
          }
        })
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    proxy: {
      '/api': createProxyConfig(),
      '/v1': createProxyConfig(),
      '/health': createProxyConfig(),
    },
  },
})
