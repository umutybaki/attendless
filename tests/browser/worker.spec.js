import { test, expect, typeCode } from './fixtures.js'

// The real Worker and Durable Object (worker/) in local workerd via `wrangler dev`,
// first over its protocol, then with two browser pages connected by real WebRTC.
const base = 'http://127.0.0.1:8787'

async function post(path, headers = {}) {
  const response = await fetch(base + path, { method: 'POST', headers })
  return { status: response.status, body: await response.json().catch(() => null) }
}

// A WebSocket client that collects messages and can wait for the next of a type.
function connect(code, token) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${code}/socket`)
  const inbox = [], waiting = []
  ws.addEventListener('message', ({ data }) => {
    inbox.push(data === 'pong' ? { type: 'pong' } : JSON.parse(data))
    waiting.splice(0).forEach((check) => check())
  })
  const closed = new Promise((resolve) => ws.addEventListener('close', ({ code }) => resolve(code)))
  const opened = new Promise((resolve) => ws.addEventListener('open', () => {
    if (token) ws.send(JSON.stringify({ type: 'hello', token }))
    resolve()
  }))
  const next = (type, ms = 5000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${type} message`)), ms)
    const check = () => {
      const i = inbox.findIndex((message) => message.type === type)
      if (i < 0) return waiting.push(check)
      clearTimeout(timer)
      resolve(inbox.splice(i, 1)[0])
    }
    check()
  })
  const say = (message) => ws.send(typeof message === 'string' ? message : JSON.stringify(message))
  return { ws, opened, closed, next, say, inbox }
}

test('rooms are created, joined, signaled and ended over the real protocol', async () => {
  const created = await post('/api/rooms')
  expect(created.status).toBe(200)
  const { code, token } = created.body
  expect(code).toMatch(/^\d{6}$/)
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  expect((await post('/api/rooms', { Origin: 'https://elsewhere.example' })).status).toBe(403)

  const host = connect(code, token)
  expect((await host.next('welcome')).role).toBe('host')
  const joined = await post(`/api/rooms/${code}/join`)
  expect(joined.status).toBe(200)
  const viewer = connect(code, joined.body.token)
  const welcome = await viewer.next('welcome')
  expect(welcome).toMatchObject({ role: 'viewer', state: { live: false, viewers: 1 }, iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
  expect((await host.next('state')).state.viewers).toBe(1)

  host.say({ type: 'live', epoch: 'e1', paused: false })
  expect((await viewer.next('state')).state).toEqual({ live: true, paused: false, viewers: 1, epoch: 'e1' })
  viewer.say({ type: 'offer', epoch: 'e1', sdp: 'v=0 viewer offer' })
  const offer = await host.next('offer')
  expect(offer.sdp).toBe('v=0 viewer offer')
  host.say({ type: 'answer', peer: offer.peer, epoch: 'e1', sdp: 'v=0 host answer' })
  expect(await viewer.next('answer')).toEqual({ type: 'answer', epoch: 'e1', sdp: 'v=0 host answer' })
  viewer.say('ping')
  await viewer.next('pong')

  // A camera that drops and comes back within the grace period changes nothing for viewers.
  host.ws.close()
  const back = connect(code, token)
  expect((await back.next('welcome')).state).toMatchObject({ live: true, epoch: 'e1' })
  expect(viewer.inbox.filter((message) => message.type === 'state' && !message.state.live)).toEqual([])

  back.say({ type: 'end' })
  await viewer.next('ended')
  expect(await viewer.closed).toBe(4410)
  expect((await post(`/api/rooms/${code}/join`)).status).toBe(404)
  expect(await connect(code, joined.body.token).closed).toBe(4410)
})

test('a phone camera and a viewer connect through the Worker with real WebRTC', async ({ context }) => {
  const camera = await context.newPage()
  await camera.goto('/?demo')
  await camera.getByRole('button', { name: 'New room' }).click()
  await expect(camera.locator('#invite-code')).toHaveText(/^\d{3} \d{3}$/)
  const code = (await camera.locator('#invite-code').textContent()).replace(/\D/g, '')
  await camera.getByRole('button', { name: 'Done' }).click()

  const viewer = await context.newPage()
  await viewer.goto('/')
  await typeCode(viewer, code)
  await expect(viewer.locator('#presence')).toHaveAttribute('data-presence', 'live')
  await expect.poll(() => viewer.evaluate(() => document.getElementById('feed').videoWidth), { timeout: 30000 }).toBeGreaterThan(0)
  await expect(viewer.locator('#link-open')).toHaveAttribute('href', /^https:\/\/forms\.example\.com\/r\/[A-Z0-9]+$/, { timeout: 30000 })

  await camera.getByRole('button', { name: 'Pause camera' }).click()
  await expect(viewer.locator('#note-title')).toHaveText('Camera paused')
  await camera.getByRole('button', { name: 'Resume' }).first().click()
  await expect(viewer.locator('#presence')).toHaveAttribute('data-presence', 'live')

  await camera.getByRole('button', { name: 'End' }).click()
  await camera.getByRole('button', { name: 'Tap to end' }).click()
  await expect(viewer.locator('#note-title')).toHaveText('Room ended')
})
