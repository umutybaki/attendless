import { test, expect, typeCode } from './fixtures.js'

// The same flows against the server protocol. The API and WebRTC are faked:
// these tests check requests, signaling and UI, not real network traversal.
const apiUrl = 'https://attendless-test.lambda-url.us-east-1.on.aws/'

async function setup(page, reply) {
  const calls = []
  await page.route('**/config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.ATTENDLESS_CONFIG = ${JSON.stringify({ apiUrl })};` }))
  await page.route(`${apiUrl}**`, async (route) => {
    const body = route.request().postDataJSON()
    calls.push(body)
    const [status, json] = reply(body) ?? [200, { ok: true }]
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json), headers: { 'Access-Control-Allow-Origin': '*' } })
  })
  await page.addInitScript(() => {
    const rtc = (window.rtc = { channels: [], outgoing: [], senders: [], pcs: [] })
    window.RTCPeerConnection = class {
      iceGatheringState = 'complete'
      connectionState = 'new'
      remoteDescription = null
      constructor() { rtc.pcs.push(this) }
      createDataChannel() {
        const channel = { readyState: 'open', close() {}, send() {} }
        rtc.channels.push(channel)
        return channel
      }
      addTransceiver() {}
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
  return calls
}
const last = (calls, action) => calls.filter((call) => call.action === action).at(-1)

test('the camera creates a room on the server and sends what it scans to viewers', async ({ page }) => {
  const calls = await setup(page, ({ action }) => ({
    create: [200, { code: '482913', token: 'h'.repeat(64) }],
    status: [200, { live: false, viewers: 0 }],
    claim: [200, { epoch: 'e1' }],
    heartbeat: [200, { viewers: 2 }],
    peers: [200, { peers: [{ peer: 'v'.repeat(64), offer: 'viewer-offer' }] }],
  })[action])
  await page.goto('/?demo')
  await page.getByRole('button', { name: 'New room' }).click()
  await expect(page.locator('#invite-code')).toHaveText('482 913')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('#presence-text')).toHaveText('2 watching')
  expect(last(calls, 'heartbeat')).toMatchObject({ epoch: 'e1', paused: false })
  await expect.poll(() => last(calls, 'answer')).toMatchObject({ epoch: 'e1', peer: 'v'.repeat(64), offer: 'viewer-offer', sdp: 'host-answer' })
  expect(await page.evaluate(() => window.rtc.senders[0])).toMatchObject({ encodings: [{ maxBitrate: 1000000, maxFramerate: 30 }], degradationPreference: 'maintain-resolution' })
  await expect.poll(() => page.evaluate(() => window.rtc.outgoing.at(-1)?.url), { timeout: 15000 }).toMatch(/^https:\/\/forms\.example\.com\/r\/[A-Z0-9]+$/)

  await page.getByRole('button', { name: 'Pause camera' }).click()
  await expect.poll(() => last(calls, 'heartbeat').paused).toBe(true)
  await page.getByRole('button', { name: 'Resume' }).first().click()
  await page.getByRole('button', { name: 'End' }).click()
  await page.getByRole('button', { name: 'Tap to end' }).click()
  await expect(page.locator('#home')).toBeVisible()
  await expect.poll(() => last(calls, 'end')).toBeTruthy()
})

test('a viewer joins on the server, connects, survives a reload, and sees the room end', async ({ page }) => {
  let ended = false
  const calls = await setup(page, ({ action, code }) => ({
    join: code === '482913' ? [200, { token: 'v'.repeat(64) }] : [404, { error: 'No room with that code' }],
    status: ended ? [410, { ended: true }] : [200, { live: true, paused: false, viewers: 3, epoch: 'e1' }],
    connection: [200, { answer: 'host-answer' }],
  })[action])
  await page.goto('/')
  await typeCode(page, '000000')
  await expect(page.locator('#home-status')).toHaveText('No room with code 000 000. Check the digits.')
  await typeCode(page, '482913')
  await expect(page.locator('#presence-text')).toHaveText('Live · 3')
  await expect.poll(() => last(calls, 'offer')).toMatchObject({ epoch: 'e1', sdp: 'viewer-offer' })
  await expect.poll(() => page.evaluate(() => window.rtc.pcs.at(-1).remoteDescription?.sdp)).toBe('host-answer')

  await page.evaluate(() => {
    const channel = window.rtc.channels.at(-1)
    const later = Date.now() + 60000
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@example.com/'])
      channel.onmessage({ data: JSON.stringify({ url, scannedAt: later }) })
    channel.onmessage({ data: 'not json' })
    channel.onmessage({ data: JSON.stringify({ url: 'https://forms.example.com/r/ABC123', scannedAt: Date.now() }) })
  })
  await expect(page.locator('#link-open')).toHaveAttribute('href', 'https://forms.example.com/r/ABC123')

  const joins = calls.filter((call) => call.action === 'join').length
  await page.reload()
  await expect(page.locator('#presence-text')).toHaveText('Live · 3')
  expect(calls.filter((call) => call.action === 'join').length).toBe(joins)

  ended = true
  await expect(page.locator('#note-title')).toHaveText('Room ended')
})

test('an unreachable server is reported, not mistaken for a wrong code', async ({ page }) => {
  await setup(page, () => {})
  await page.route(`${apiUrl}**`, (route) => route.abort())
  await page.goto('/')
  await typeCode(page, '482913')
  await expect(page.locator('#home-status')).toHaveText('Couldn’t reach Attendless. Check your connection and try again.')
  await page.getByRole('button', { name: 'New room' }).click()
  await expect(page.locator('#home-status')).toHaveText('Couldn’t reach Attendless. Check your connection and try again.')
})
