// Runs after deployment against SITE_URL: checks the site, its headers and
// configuration, then creates, joins, connects to and ends one real room.
const siteUrl = process.env.SITE_URL
if (!siteUrl) throw new Error('Set SITE_URL')
const check = (ok, message) => { if (!ok) throw new Error(message) }
const url = (path) => new URL(path, siteUrl)

async function get(path) {
  const response = await fetch(url(path))
  check(response.ok, `${path}: HTTP ${response.status}`)
  return response
}
// A new custom domain can take a minute to get its certificate.
for (let attempt = 1; ; attempt++) {
  try { await get('/'); break } catch (error) {
    if (attempt === 12) throw error
    await new Promise((resolve) => setTimeout(resolve, 10000))
  }
}
const page = await get('/')
check((await page.text()).includes('id="new-room"'), 'Frontend was not uploaded')
check(page.headers.get('strict-transport-security')?.includes('max-age='), 'Security headers are missing')
check(page.headers.get('permissions-policy')?.includes('camera=(self)'), 'Permissions-Policy must allow the camera')
const config = await (await get('/config.js')).text()
check(config.includes('"apiUrl":"/api"'), 'Frontend does not point at /api')
const aptabaseKey = process.env.ATTENDLESS_APTABASE_KEY
if (aptabaseKey) check(config.includes(JSON.stringify(aptabaseKey)), 'Frontend is missing the analytics key')
await get('/vendor/jsQR.js')

async function post(path, headers = {}) {
  const response = await fetch(url(path), { method: 'POST', headers })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
function connect(code, token) {
  const socketUrl = url(`/api/rooms/${code}/socket`)
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(socketUrl)
  const inbox = [], waiting = []
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token })))
  ws.addEventListener('message', ({ data }) => {
    if (data !== 'pong') inbox.push(JSON.parse(data))
    waiting.splice(0).forEach((look) => look())
  })
  const next = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${type} message`)), 10000)
    const look = () => {
      const i = inbox.findIndex((message) => message.type === type)
      if (i < 0) return waiting.push(look)
      clearTimeout(timer)
      resolve(inbox.splice(i, 1)[0])
    }
    look()
  })
  const closed = new Promise((resolve) => ws.addEventListener('close', ({ code }) => resolve(code)))
  return { ws, next, closed }
}

check((await post('/api/rooms', { Origin: 'https://elsewhere.example' })).status === 403, 'Another site could create rooms')
const created = await post('/api/rooms')
check(created.status === 200 && /^\d{6}$/.test(created.body.code) && created.body.token?.length === 64, `Room creation failed: HTTP ${created.status}`)
const { code, token } = created.body
const host = connect(code, token)
const hostWelcome = await host.next('welcome')
check(hostWelcome.role === 'host', 'The camera was not recognized')
const joined = await post(`/api/rooms/${code}/join`)
check(joined.status === 200 && joined.body.token, `Joining failed: HTTP ${joined.status}`)
const viewer = connect(code, joined.body.token)
const welcome = await viewer.next('welcome')
check(welcome.role === 'viewer', 'The viewer was not recognized')
check((await host.next('state')).state.viewers === 1, 'The camera did not see the viewer')
const turn = welcome.iceServers.some((server) => [server.urls].flat().some((u) => u.startsWith('turn')))
host.ws.send(JSON.stringify({ type: 'end' }))
await viewer.next('ended')
check((await viewer.closed) === 4410, 'The viewer was not disconnected')
check((await post(`/api/rooms/${code}/join`)).status === 404, 'An ended room accepted a viewer')
console.log(`Verified the site, headers, configuration and a full room lifecycle (room ${code}, now ended); TURN ${turn ? 'on' : 'off (STUN only)'}`)
