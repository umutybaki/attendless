import { test, expect, typeCode } from './fixtures.js'

// The same flows against the server protocol (worker/room.js). HTTP, the room
// WebSocket and WebRTC are faked: these tests check messages, signaling and UI,
// not real network traversal. worker.spec.js runs the real Worker.
const turn = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' }]

async function setup(page, { post = () => null, socket = () => {} } = {}, config = {}) {
  const calls = []
  const sockets = []
  await page.route('**/config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.ATTENDLESS_CONFIG = ${JSON.stringify({ apiUrl: '/api', ...config })};` }))
  const api = (url) => url.host === '127.0.0.1:3000' && url.pathname.startsWith('/api/')
  await page.route(api, async (route) => {
    const path = new URL(route.request().url()).pathname
    calls.push(path)
    const [status, json] = post(path) ?? [404, { error: 'Not found' }]
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) })
  })
  await page.routeWebSocket(/\/api\/rooms\/\d{6}\/socket$/, (ws) => {
    const line = { ws, url: ws.url(), received: [], send: (message) => ws.send(JSON.stringify(message)) }
    line.last = (type) => line.received.filter((m) => m.type === type).at(-1)
    sockets.push(line)
    ws.onMessage((data) => {
      if (data === 'ping') return ws.send('pong')
      const message = JSON.parse(data)
      line.received.push(message)
      socket(line, message)
    })
  })
  await page.addInitScript(() => {
    const rtc = (window.rtc = { channels: [], outgoing: [], senders: [], pcs: [] })
    window.RTCPeerConnection = class {
      iceGatheringState = 'complete'
      connectionState = 'new'
      remoteDescription = null
      constructor(config) {
        this.config = config
        rtc.pcs.push(this)
      }
      createDataChannel() {
        const channel = { readyState: 'open', close() {}, send() {} }
        rtc.channels.push(channel)
        return channel
      }
      addTransceiver() {}
      addEventListener() {}
      async createOffer() { return { type: 'offer', sdp: 'viewer-offer' } }
      async createAnswer() { return { type: 'answer', sdp: 'host-answer' } }
      async setLocalDescription(description) { this.localDescription = description }
      async setRemoteDescription(description) {
        this.remoteDescription = description
        if (!this.ondatachannel) return
        const channel = { readyState: 'open', bufferedAmount: 0, close() {}, send(data) { rtc.outgoing.push(JSON.parse(data)) } }
        this.ondatachannel({ channel })
        channel.onopen?.()
      }
      addTrack() {
        return { getParameters: () => ({ encodings: [{}] }), setParameters: async (params) => { rtc.senders.push(params) } }
      }
      close() {}
    }
  })
  return { calls, sockets }
}

const host = (token = 'h'.repeat(64), state = { live: false, paused: false, viewers: 0 }) => (line, message) => {
  if (message.type === 'hello' && message.token === token) line.send({ type: 'welcome', role: 'host', state, iceServers: turn })
}

test('the camera creates a room, goes live over its socket and answers viewers', async ({ page }) => {
  const { calls, sockets } = await setup(page, {
    post: (path) => (path === '/api/rooms' ? [200, { code: '482913', token: 'h'.repeat(64) }] : null),
    socket: host(),
  })
  await page.goto('/?demo')
  await page.getByRole('button', { name: 'New room' }).click()
  await expect(page.locator('#invite-code')).toHaveText('482 913')
  await page.getByRole('button', { name: 'Done' }).click()
  expect(calls).toEqual(['/api/rooms'])
  await expect.poll(() => sockets[0]?.last('live')).toMatchObject({ epoch: expect.stringMatching(/^[0-9a-f]{32}$/), paused: false })
  const line = sockets[0]
  expect(line.url).toBe('ws://127.0.0.1:3000/api/rooms/482913/socket')
  expect(line.received[0]).toEqual({ type: 'hello', token: 'h'.repeat(64) })

  line.send({ type: 'state', state: { live: true, paused: false, viewers: 2, epoch: line.last('live').epoch } })
  await expect(page.locator('#presence-text')).toHaveText('2 watching')

  const epoch = line.last('live').epoch
  line.send({ type: 'offer', peer: 'p1', sdp: 'viewer-offer' })
  await expect.poll(() => line.last('answer')).toEqual({ type: 'answer', peer: 'p1', epoch, sdp: 'host-answer' })
  expect(await page.evaluate(() => window.rtc.pcs[0].config.iceServers.at(-1).urls[0])).toBe('turn:turn.example:3478?transport=udp')
  // A small stream for viewers: the camera reads codes from its own full-resolution capture.
  expect(await page.evaluate(() => window.rtc.senders[0])).toMatchObject({ encodings: [{ maxBitrate: 400000, maxFramerate: 15 }], degradationPreference: 'maintain-resolution' })
  await expect.poll(() => page.evaluate(() => window.rtc.outgoing.at(-1)?.url), { timeout: 15000 }).toMatch(/^https:\/\/forms\.example\.com\/r\/[A-Z0-9]+$/)

  await page.getByRole('button', { name: 'Pause camera' }).click()
  await expect.poll(() => line.last('live')).toEqual({ type: 'live', epoch, paused: true })
  await page.getByRole('button', { name: 'Resume' }).first().click()
  await expect.poll(() => line.last('live')).toEqual({ type: 'live', epoch, paused: false })
  await page.getByRole('button', { name: 'End' }).click()
  await page.getByRole('button', { name: 'Tap to end' }).click()
  await expect(page.locator('#home')).toBeVisible()
  await expect.poll(() => line.last('end')).toEqual({ type: 'end' })
})

test('a camera that reconnects announces its stream again', async ({ page }) => {
  const { sockets } = await setup(page, {
    post: (path) => (path === '/api/rooms' ? [200, { code: '482913', token: 'h'.repeat(64) }] : null),
    socket: host(),
  })
  await page.goto('/?demo')
  await page.getByRole('button', { name: 'New room' }).click()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => sockets[0]?.last('live')).toBeTruthy()
  const { epoch } = sockets[0].last('live')
  sockets[0].ws.close({ code: 1006, reason: '' })
  await expect.poll(() => sockets[1]?.last('live'), { timeout: 10000 }).toEqual({ type: 'live', epoch, paused: false })
})

test('a viewer joins, connects, survives a reload, and sees the room end', async ({ page }) => {
  let state = { live: true, paused: false, viewers: 3, epoch: 'e1' }
  const { calls, sockets } = await setup(page, {
    post: (path) => (path === '/api/rooms/482913/join' ? [200, { token: 'v'.repeat(64) }] : null),
    socket: (line, message) => {
      if (message.type === 'hello') line.send({ type: 'welcome', role: 'viewer', state, iceServers: turn })
      if (message.type === 'offer') line.send({ type: 'answer', epoch: message.epoch, sdp: 'host-answer' })
    },
  })
  await page.goto('/')
  await typeCode(page, '000000')
  await expect(page.locator('#home-status')).toHaveText('No room with code 000 000. Check the digits.')
  await typeCode(page, '482913')
  await expect(page.locator('#presence-text')).toHaveText('Live · 3')
  await expect.poll(() => sockets[0].last('offer')).toEqual({ type: 'offer', epoch: 'e1', sdp: 'viewer-offer' })
  await expect.poll(() => page.evaluate(() => window.rtc.pcs.at(-1).remoteDescription?.sdp)).toBe('host-answer')
  expect(await page.evaluate(() => window.rtc.pcs.at(-1).config.iceServers)).toEqual(turn)

  await page.evaluate(() => {
    const channel = window.rtc.channels.at(-1)
    const later = Date.now() + 60000
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@example.com/'])
      channel.onmessage({ data: JSON.stringify({ url, scannedAt: later }) })
    channel.onmessage({ data: 'not json' })
    channel.onmessage({ data: JSON.stringify({ url: 'https://forms.example.com/r/ABC123', scannedAt: Date.now() }) })
  })
  await expect(page.locator('#link-open')).toHaveAttribute('href', 'https://forms.example.com/r/ABC123')

  // Pause and resume arrive as pushed state; nobody polls.
  sockets[0].send({ type: 'state', state: { ...state, paused: true } })
  await expect(page.locator('#note-title')).toHaveText('Camera paused')

  await page.reload()
  await expect(page.locator('#presence-text')).toHaveText('Live · 3')
  expect(calls.filter((path) => path.endsWith('/join'))).toHaveLength(2)
  expect(sockets.at(-1).received[0]).toEqual({ type: 'hello', token: 'v'.repeat(64) })

  state = { live: false, paused: false, viewers: 3 }
  sockets.at(-1).send({ type: 'ended' })
  sockets.at(-1).ws.close({ code: 4410, reason: 'Room ended' })
  await expect(page.locator('#note-title')).toHaveText('Room ended')
})

test('a reload into a room that ended meanwhile returns to the keypad', async ({ page }) => {
  let ended = false
  await setup(page, {
    post: (path) => (path === '/api/rooms/482913/join' ? [200, { token: 'v'.repeat(64) }] : null),
    socket: (line, message) => {
      if (message.type !== 'hello') return
      if (ended) return line.ws.close({ code: 4410, reason: 'Room ended' })
      line.send({ type: 'welcome', role: 'viewer', state: { live: false, paused: false, viewers: 1 }, iceServers: turn })
    },
  })
  await page.goto('/')
  await typeCode(page, '482913')
  await expect(page.locator('#note-title')).toHaveText('Waiting for the camera')
  ended = true
  await page.reload()
  await expect(page.locator('#home-status')).toHaveText('No room with code 482 913. Check the digits.')
})

test('an unreachable server is reported, not mistaken for a wrong code', async ({ page }) => {
  await setup(page)
  await page.route((url) => url.host === '127.0.0.1:3000' && url.pathname.startsWith('/api/'), (route) => route.abort())
  await page.goto('/')
  await typeCode(page, '482913')
  await expect(page.locator('#home-status')).toHaveText('Couldn’t reach Attendless. Check your connection and try again.')
  await page.getByRole('button', { name: 'New room' }).click()
  await expect(page.locator('#home-status')).toHaveText('Couldn’t reach Attendless. Check your connection and try again.')
})

const aptabaseKey = 'A-EU-0000000000'
async function collectEvents(page) {
  const events = []
  await page.route('https://eu.aptabase.com/**', async (route) => {
    events.push({ key: route.request().headers()['app-key'], ...route.request().postDataJSON() })
    await route.fulfill({ status: 200, body: '' })
  })
  return events
}
const names = (events) => events.map((event) => event.eventName)

test('analytics send one event per milestone per room, without codes, tokens or links', async ({ context }) => {
  const camera = await context.newPage()
  const cameraEvents = await collectEvents(camera)
  await setup(camera, {
    post: (path) => (path === '/api/rooms' ? [200, { code: '482913', token: 'h'.repeat(64) }] : null),
    socket: host(),
  }, { aptabaseKey })
  await camera.goto('/?demo')
  await camera.getByRole('button', { name: 'New room' }).click()
  await camera.locator('#invite-copy').click()
  await camera.locator('#invite-copy').click()
  await camera.getByRole('button', { name: 'Done' }).click()
  await expect(camera.locator('#link-host')).toHaveText('forms.example.com', { timeout: 15000 })
  await camera.getByRole('button', { name: 'End' }).click()
  await camera.getByRole('button', { name: 'Tap to end' }).click()
  await expect.poll(() => names(cameraEvents)).toContain('room_closed')

  const viewer = await context.newPage()
  const viewerEvents = await collectEvents(viewer)
  await setup(viewer, {
    post: (path) => (path === '/api/rooms/482913/join' ? [200, { token: 'v'.repeat(64) }] : null),
    socket: (line, message) => {
      if (message.type === 'hello') line.send({ type: 'welcome', role: 'viewer', state: { live: true, paused: false, viewers: 3, epoch: 'e1' }, iceServers: turn })
    },
  }, { aptabaseKey })
  await viewer.goto('/')
  await typeCode(viewer, '000000')
  await typeCode(viewer, '000001')
  await typeCode(viewer, '482913')
  await expect(viewer.locator('#presence-text')).toHaveText('Live · 3')
  await viewer.evaluate(() => window.rtc.channels.at(-1).onmessage({ data: JSON.stringify({ url: 'https://forms.example.com/r/ABC123', scannedAt: Date.now() }) }))
  await viewer.locator('#link-copy').click()
  await viewer.locator('#link-copy').click()
  await expect.poll(() => names(viewerEvents)).toContain('link_opened')
  await viewer.reload()
  await expect(viewer.locator('#presence-text')).toHaveText('Live · 3')
  await viewer.waitForTimeout(300)

  expect(names(cameraEvents)).toEqual(['room_created', 'invite_shared', 'room_closed'])
  // A second typo, a second copy and a reload send nothing more.
  expect(names(viewerEvents)).toEqual(['join_failed', 'room_joined', 'link_opened'])
  const all = [...cameraEvents, ...viewerEvents]
  expect(all.every((event) => event.key === aptabaseKey && event.systemProps.isDebug === true)).toBe(true)
  expect(new Set(all.map((event) => event.sessionId)).size).toBe(2)
  expect(cameraEvents[0].props).toEqual({ lang: 'en' })
  expect(cameraEvents[2].props).toEqual({ how: 'end', minutes: 0, links: expect.any(Number), peak_viewers: expect.any(Number), first_link_seconds: expect.any(Number) })
  expect(viewerEvents[0].props).toEqual({ via: 'code', reason: 'not_found' })
  expect(viewerEvents[1].props).toEqual({ via: 'code', lang: 'en' })
  const sent = JSON.stringify(all)
  for (const secret of ['482913', '482 913', 'h'.repeat(64), 'v'.repeat(64), 'forms.example.com', 'ABC123', '/r/'])
    expect(sent).not.toContain(secret)
})
