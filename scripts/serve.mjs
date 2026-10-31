import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../dist/', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const port = Number(process.env.PORT || 3000)
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end(); return }
    const data = await readFile(path)
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'text/plain', 'Cache-Control': 'no-store' })
    res.end(data)
  } catch { res.writeHead(404).end('Not found') }
}).listen(port, '127.0.0.1', () => console.log(`Attendless listening on port ${port}`))
