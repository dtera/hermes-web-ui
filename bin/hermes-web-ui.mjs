#!/usr/bin/env node
import { createServer as createViteServer } from 'http'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { readFile, stat, readdir, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = resolve(__dirname, '..', 'dist')
const API_TARGET = 'http://127.0.0.1:8642'
const DEFAULT_PORT = 8648
const UPLOAD_DIR = join(tmpdir(), 'hermes-uploads')

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function getMimeType(filePath) {
  const ext = filePath.substring(filePath.lastIndexOf('.'))
  return MIME_TYPES[ext] || 'application/octet-stream'
}

async function ensureUploadDir() {
  await mkdir(UPLOAD_DIR, { recursive: true })
}

async function serveStatic(reqPath, res) {
  let filePath = join(distDir, reqPath)
  try {
    const s = await stat(filePath)
    if (s.isDirectory()) filePath = join(filePath, 'index.html')
    const data = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': getMimeType(filePath),
      'Cache-Control': 'public, max-age=3600',
    })
    res.end(data)
  } catch {
    // SPA fallback
    try {
      const data = await readFile(join(distDir, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  }
}

async function handleUpload(req, res) {
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
    await ensureUploadDir()
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()

    const boundary = '--' + contentType.split('boundary=')[1]
    const parts = body.split(boundary).slice(1, -1)

    const results = []
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n')
      if (headerEnd === -1) continue
      const header = part.substring(0, headerEnd)
      const data = part.substring(headerEnd + 4, part.length - 2)

      const nameMatch = header.match(/name="([^"]+)"/)
      const filenameMatch = header.match(/filename="([^"]+)"/)
      if (!nameMatch || !filenameMatch) continue

      const filename = filenameMatch[1]
      const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
      const savedName = randomBytes(8).toString('hex') + ext
      const savedPath = join(UPLOAD_DIR, savedName)

      await writeFile(savedPath, Buffer.from(data, 'binary'))
      results.push({ name: filename, path: savedPath })
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ files: results }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function proxyRequest(req, res, reqPath) {
  const url = `${API_TARGET}${reqPath}`
  const headers = { ...req.headers, host: '127.0.0.1:8642' }
  delete headers['origin']
  delete headers['referer']

  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const bodyChunks = hasBody ? [] : null
    if (hasBody) {
      for await (const chunk of req) bodyChunks.push(chunk)
    }

    const apiRes = await fetch(url, {
      method: req.method,
      headers,
      body: bodyChunks ? Buffer.concat(bodyChunks) : undefined,
    })

    const resHeaders = {}
    apiRes.headers.forEach((v, k) => {
      if (k !== 'transfer-encoding' && k !== 'connection') {
        resHeaders[k] = v
      }
    })
    resHeaders['x-accel-buffering'] = 'no'
    resHeaders['cache-control'] = 'no-cache'

    res.writeHead(apiRes.status, resHeaders)

    if (apiRes.body) {
      const reader = apiRes.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      }
      await pump()
    } else {
      res.end()
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
    }
    res.end(JSON.stringify({ error: { message: `API proxy error: ${err.message}` } }))
  }
}

const command = process.argv[2]

if (command === 'build') {
  console.log('Build is done during npm install. Use "npm run build" in the source repo.')
  process.exit(1)
}

// start (default)
const port = parseInt(process.argv[2] && !isNaN(process.argv[2]) ? process.argv[2] : process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '') || DEFAULT_PORT

createViteServer(async (req, res) => {
  const reqPath = req.url.split('?')[0]

  if (reqPath === '/__upload') {
    await handleUpload(req, res)
  } else if (reqPath.startsWith('/api/') || reqPath.startsWith('/v1/') || reqPath === '/health' || reqPath.startsWith('/health')) {
    await proxyRequest(req, res, reqPath)
  } else {
    await serveStatic(reqPath, res)
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`  ➜  Hermes Web UI: http://localhost:${port}`)
})
