import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const apiUrl = process.env.ATTENDLESS_API_URL || ''
if (apiUrl && (!['https:', 'http:'].includes(new URL(apiUrl).protocol) || new URL(apiUrl).username || new URL(apiUrl).password)) {
  throw new Error('ATTENDLESS_API_URL must be an HTTP(S) URL without credentials')
}
await rm(`${root}dist`, { recursive: true, force: true })
await cp(`${root}public`, `${root}dist`, { recursive: true })
await mkdir(`${root}dist/vendor`, { recursive: true })
await cp(`${root}node_modules/jsqr/dist/jsQR.js`, `${root}dist/vendor/jsQR.js`)
await cp(`${root}node_modules/jsqr/LICENSE`, `${root}dist/vendor/jsQR-LICENSE`)
await writeFile(`${root}dist/config.js`, `window.ATTENDLESS_CONFIG = ${JSON.stringify({ apiUrl })};\n`)
console.log(`Static site built in dist/ (${apiUrl ? 'API configured' : 'no API; room controls disabled'})`)
