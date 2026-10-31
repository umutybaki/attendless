// Runs after deployment: checks the site, its headers and API wiring, then
// creates, joins and ends one real room (its items expire with the table TTL).
const siteUrl = process.env.SITE_URL
const apiUrl = process.env.ATTENDLESS_API_URL
if (!siteUrl || !apiUrl) throw new Error('Set SITE_URL and ATTENDLESS_API_URL')
const check = (ok, message) => { if (!ok) throw new Error(message) }

async function get(path) {
  const response = await fetch(new URL(path, siteUrl))
  check(response.ok, `${path}: HTTP ${response.status}`)
  return response
}
const page = await get('/')
check((await page.text()).includes('id="new-room"'), 'Frontend was not uploaded')
check(page.headers.get('strict-transport-security')?.includes('max-age='), 'Security headers are missing')
check(page.headers.get('permissions-policy')?.includes('camera=(self)'), 'Permissions-Policy must allow the camera')
const config = await (await get('/config.js')).text()
check(config.includes(JSON.stringify(apiUrl)), 'Frontend points at the wrong API')
const aptabaseKey = process.env.ATTENDLESS_APTABASE_KEY
if (aptabaseKey) {
  check(config.includes(JSON.stringify(aptabaseKey)), 'Frontend is missing the analytics key')
  await get('/vendor/aptabase.js')
}
await get('/vendor/jsQR.js')

const preflight = await fetch(apiUrl, {
  method: 'OPTIONS',
  headers: { Origin: siteUrl, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
})
check(preflight.ok && preflight.headers.get('access-control-allow-origin') === siteUrl, 'API CORS preflight failed')

async function call(body, token = '') {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { Origin: siteUrl, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const created = await call({ action: 'create' })
check(created.status === 200 && /^\d{6}$/.test(created.body.code) && created.body.token?.length === 64, `Room creation failed: HTTP ${created.status}`)
const { code, token: host } = created.body
const joined = await call({ action: 'join', code })
check(joined.status === 200 && joined.body.token?.length === 64, `Joining failed: HTTP ${joined.status}`)
const viewer = joined.body.token
check((await call({ action: 'status' }, viewer)).body.host === false, 'Viewer status failed')
const hosted = await call({ action: 'status' }, host)
check(hosted.body.host === true && hosted.body.viewers === 1, 'Host status or presence failed')
check((await call({ action: 'claim' }, viewer)).status === 403, 'A viewer could claim the camera')
check((await call({ action: 'end' }, host)).status === 200, 'Ending the room failed')
check((await call({ action: 'status' }, viewer)).status === 410, 'The viewer did not see the room end')
check((await call({ action: 'join', code })).status === 404, 'An ended room accepted a viewer')
console.log(`Verified frontend, headers, API configuration, CORS, and a full room lifecycle (room ${code}, now ended)`)
