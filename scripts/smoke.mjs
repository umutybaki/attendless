// Runs after deployment; creates one two-hour session without claiming a camera lease.
const siteUrl = process.env.SITE_URL
const apiUrl = process.env.ATTENDLESS_API_URL
if (!siteUrl || !apiUrl) throw new Error('Set SITE_URL and ATTENDLESS_API_URL')
async function get(path) {
  const response = await fetch(new URL(path, siteUrl))
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.text()
}
if (!(await get('/')).includes('id="join-form"')) throw new Error('Frontend was not uploaded')
if (!(await get('/config.js')).includes(JSON.stringify(apiUrl))) throw new Error('Frontend points at the wrong API')
await get('/vendor/jsQR.js')
const preflight = await fetch(apiUrl, {
  method: 'OPTIONS',
  headers: { Origin: siteUrl, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
})
if (!preflight.ok || preflight.headers.get('access-control-allow-origin') !== siteUrl) throw new Error('API CORS preflight failed')
async function call(body, token = '') {
  return fetch(apiUrl, {
    method: 'POST',
    headers: { Origin: siteUrl, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}
if ((await call({ action: 'join', code: '000000' })).status !== 401) throw new Error('Invalid room code was accepted')
const joined = await call({ action: 'join', code: '313131' })
if (!joined.ok) throw new Error(`Room join failed: HTTP ${joined.status}`)
const { token } = await joined.json()
if (typeof token !== 'string' || token.length !== 64) throw new Error('Invalid session response')
const status = await call({ action: 'status' }, token)
if (!status.ok || typeof (await status.json()).active !== 'boolean') throw new Error('Room status failed')
console.log('Deployed frontend, API configuration, CORS, code rejection, DynamoDB session and room status verified')
