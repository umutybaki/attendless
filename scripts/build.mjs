import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, process.env.ATTENDLESS_OUT || 'dist')
// The room API: a path on the site's own origin (production: /api) or a full
// HTTP(S) URL. Empty runs rooms between tabs of one browser, for UI work and tests.
const apiUrl = process.env.ATTENDLESS_API_URL || ''
if (apiUrl && !apiUrl.startsWith('/')) {
  const url = new URL(apiUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('ATTENDLESS_API_URL must be a path or an HTTP(S) URL without credentials')
}
// Aptabase app keys are public client identifiers, like the API URL.
const aptabaseKey = process.env.ATTENDLESS_APTABASE_KEY || ''
if (aptabaseKey && !/^A-EU-\d+$/.test(aptabaseKey)) throw new Error('ATTENDLESS_APTABASE_KEY must be an EU Aptabase app key (A-EU-…)')
await rm(out, { recursive: true, force: true })
await cp(`${root}public`, out, { recursive: true })
await mkdir(`${out}/vendor`, { recursive: true })
await cp(`${root}node_modules/jsqr/dist/jsQR.js`, `${out}/vendor/jsQR.js`)
await cp(`${root}node_modules/jsqr/LICENSE`, `${out}/vendor/jsQR-LICENSE`)
// qrcode-generator carries its MIT license in the file header.
await cp(`${root}node_modules/qrcode-generator/qrcode.js`, `${out}/vendor/qrcode.js`)
await writeFile(`${out}/config.js`, `window.ATTENDLESS_CONFIG = ${JSON.stringify({ apiUrl, aptabaseKey })};\n`)
console.log(`Static site built in ${out} (${apiUrl ? `API at ${apiUrl}` : 'no API; rooms run between tabs of one browser'}${aptabaseKey ? ', analytics on' : ''})`)
