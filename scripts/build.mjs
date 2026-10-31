import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const apiUrl = process.env.ATTENDLESS_API_URL || ''
if (apiUrl && (!['https:', 'http:'].includes(new URL(apiUrl).protocol) || new URL(apiUrl).username || new URL(apiUrl).password)) {
  throw new Error('ATTENDLESS_API_URL must be an HTTP(S) URL without credentials')
}
// Aptabase app keys are public client identifiers, like the API URL.
const aptabaseKey = process.env.ATTENDLESS_APTABASE_KEY || ''
if (aptabaseKey && !/^A-EU-\d+$/.test(aptabaseKey)) throw new Error('ATTENDLESS_APTABASE_KEY must be an EU Aptabase app key (A-EU-…)')
await rm(`${root}dist`, { recursive: true, force: true })
await cp(`${root}public`, `${root}dist`, { recursive: true })
await mkdir(`${root}dist/vendor`, { recursive: true })
await cp(`${root}node_modules/jsqr/dist/jsQR.js`, `${root}dist/vendor/jsQR.js`)
await cp(`${root}node_modules/jsqr/LICENSE`, `${root}dist/vendor/jsQR-LICENSE`)
// qrcode-generator carries its MIT license in the file header.
await cp(`${root}node_modules/qrcode-generator/qrcode.js`, `${root}dist/vendor/qrcode.js`)
// The SDK is a dependency-free ES module; drop its source map reference.
const aptabase = await readFile(`${root}node_modules/@aptabase/web/dist/index.js`, 'utf8')
await writeFile(`${root}dist/vendor/aptabase.js`, aptabase.replace(/\n?\/\/# sourceMappingURL=.*$/, '\n'))
await cp(`${root}node_modules/@aptabase/web/LICENSE`, `${root}dist/vendor/aptabase-LICENSE`)
await writeFile(`${root}dist/config.js`, `window.ATTENDLESS_CONFIG = ${JSON.stringify({ apiUrl, aptabaseKey })};\n`)
console.log(`Static site built in dist/ (${apiUrl ? 'API configured' : 'no API; rooms run between tabs of one browser'}${aptabaseKey ? ', analytics on' : ''})`)
