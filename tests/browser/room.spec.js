import { test, expect } from '@playwright/test'

async function setup(page, { phone = false, active = true } = {}) {
  const calls = []
  let occupied = active
  await page.addInitScript(({ phone }) => {
    if (phone) {
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla iPhone' })
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 })
    }
    window.roomTest = { channels: [], senders: [], outgoing: [], pcs: [], stops: 0 }
    const state = window.roomTest
    class FakePC {
      constructor() { state.pcs.push(this) }
      iceGatheringState = 'complete'
      remoteDescription = null
      connectionState = 'new'
      createDataChannel() {
        const ch = { readyState: 'open', close() {}, send() {} }
        state.channels.push(ch)
        return ch
      }
      addTransceiver() {}
      async createOffer() { return { type: 'offer', sdp: 'a-valid-viewer-offer' } }
      async createAnswer() { return { type: 'answer', sdp: 'a-valid-sharer-answer' } }
      async setLocalDescription(value) { this.localDescription = value }
      async setRemoteDescription(value) {
        this.remoteDescription = value
        if (this.ondatachannel) {
          const ch = { readyState: 'open', bufferedAmount: 0, close() {}, send(data) { state.outgoing.push(JSON.parse(data)) } }
          this.ondatachannel({ channel: ch })
          ch.onopen?.()
        }
      }
      addTrack() {
        const sender = { getParameters: () => ({ encodings: [{}] }), setParameters: async (params) => { state.senders.push(params) } }
        return sender
      }
      close() {}
    }
    window.RTCPeerConnection = FakePC
    const track = { getSettings: () => ({ width: 1280, height: 720 }), stop() { state.stops++ } }
    const camera = { getTracks: () => [track], getVideoTracks: () => [track] }
    navigator.mediaDevices.getUserMedia = async (constraints) => { state.constraints = constraints; return camera }
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { writable: true, value: null })
    HTMLMediaElement.prototype.play = async () => {}
  }, { phone })
  await page.route('https://api.example.test/**', async (route) => {
    const body = route.request().postDataJSON()
    calls.push(body)
    let status = 200, reply = {}
    if (body.action === 'join') {
      if (body.code !== '313131') { status = 401; reply = { error: 'Incorrect code' } }
      else reply = { token: 'a'.repeat(64) }
    }
    if (body.action === 'claim') { occupied = true; reply = { epoch: 'room-epoch' } }
    if (body.action === 'release') occupied = false
    if (body.action === 'status') reply = { active: occupied, sharing: phone, epoch: 'room-epoch' }
    if (body.action === 'peers') reply = { peers: [{ peer: 'viewer', offer: 'a-valid-viewer-offer' }] }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(reply), headers: { 'Access-Control-Allow-Origin': '*' } })
  })
  return calls
}
async function join(page) {
  await page.getByLabel('Six-digit room code').fill('313131')
  await page.getByRole('button', { name: 'Join room', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Leave room' })).toBeVisible()
}
async function scan(page, url, scannedAt) {
  await page.evaluate(({ url, scannedAt }) => {
    window.roomTest.channels[0].onmessage({ data: JSON.stringify({ url, scannedAt }) })
  }, { url, scannedAt })
}

test('desktop receives links, rejects unsafe or older scans, and clears on rejoin', async ({ page }) => {
  await setup(page)
  await page.goto('/')
  await join(page)
  await expect.poll(() => page.evaluate(() => typeof window.roomTest.channels[0]?.onmessage)).toBe('function')
  await expect(page.getByRole('button', { name: 'Share camera' })).toBeHidden()
  await scan(page, 'https://example.com/first', 1000)
  const link = page.getByRole('link', { name: 'Open QR link' })
  await expect(link).toHaveAttribute('href', 'https://example.com/first')
  for (const [url, at] of [['', 2000], ['javascript:alert(1)', 2000], ['https://example.com/stale', 900]])
    await scan(page, url, at)
  await expect(link).toHaveAttribute('href', 'https://example.com/first')
  await scan(page, 'https://example.com/second', 3000)
  await expect(link).toHaveAttribute('href', 'https://example.com/second')
  await expect(page.locator('#scanned-at')).toContainText('Scanned at')
  await page.getByRole('button', { name: 'Leave room' }).click()
  await join(page)
  await expect(link).toBeHidden()
})

test('incorrect code stays outside the room; Turkish UI works', async ({ page }) => {
  await setup(page)
  await page.goto('/')
  await page.getByLabel('Six-digit room code').fill('000000')
  await page.getByRole('button', { name: 'Join room', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Incorrect code.')
  await expect(page.locator('#room')).toBeHidden()
  await page.getByRole('link', { name: 'Türkçe' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr')
  await expect(page.getByRole('button', { name: 'Odaya katıl' })).toBeVisible()
})

test('phone claims the lease, caps the sender, releases and stops all tracks', async ({ page }) => {
  const calls = await setup(page, { phone: true, active: false })
  await page.goto('/')
  await join(page)
  await page.getByRole('button', { name: 'Share camera', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible()
  await expect.poll(() => calls.some((call) => call.action === 'answer')).toBe(true)
  const state = await page.evaluate(() => window.roomTest)
  expect(state.constraints.audio).toBe(false)
  expect(state.constraints.video.height.ideal).toBe(720)
  expect(state.senders[0].encodings[0]).toMatchObject({ maxBitrate: 1000000, maxFramerate: 30 })
  await page.getByRole('button', { name: 'Stop sharing' }).click()
  await expect.poll(() => calls.some((call) => call.action === 'release' && call.epoch === 'room-epoch')).toBe(true)
  await expect.poll(() => page.evaluate(() => window.roomTest.stops)).toBeGreaterThan(0)
})

test('missing backend disables room entry', async ({ page }) => {
  await page.route('**/config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'window.ATTENDLESS_CONFIG = { apiUrl: "" };' }))
  await page.goto('/')
  await page.getByLabel('Six-digit room code').fill('313131')
  await expect(page.getByRole('button', { name: 'Join room', exact: true })).toBeDisabled()
  await expect(page.locator('#unavailable')).toBeVisible()
})


test('scanner retains and repeats the last QR, and ignores non-HTTP codes', async ({ page }) => {
  await setup(page, { phone: true, active: false })
  await page.goto('/')
  // Create the scanner's context before the module loads, preserving our QR stub after load.
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => ({
      drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    })
    Object.defineProperties(HTMLVideoElement.prototype, {
      readyState: { get: () => 4 }, currentTime: { get: () => performance.now() / 1000 },
      videoWidth: { get: () => 1280 }, videoHeight: { get: () => 720 },
    })
  })
  await page.reload()
  await page.evaluate(() => {
    window.roomTest.qr = 'https://example.com/scanned'
    window.jsQR = () => ({ data: window.roomTest.qr })
  })
  await join(page)
  await page.getByRole('button', { name: 'Share camera', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Open QR link' })).toHaveAttribute('href', 'https://example.com/scanned')
  await expect.poll(() => page.evaluate(() => window.roomTest.outgoing.length)).toBeGreaterThan(1)
  const first = await page.evaluate(() => window.roomTest.outgoing[0])
  await page.evaluate(() => { window.roomTest.qr = 'javascript:alert(1)' })
  await expect.poll(() => page.evaluate(() => window.roomTest.outgoing.length)).toBeGreaterThan(3)
  expect(await page.evaluate(() => window.roomTest.outgoing.at(-1))).toEqual(first)
  await page.evaluate(() => { window.roomTest.qr = 'https://example.com/new' })
  await expect(page.getByRole('link', { name: 'Open QR link' })).toHaveAttribute('href', 'https://example.com/new')
})

test('expired session returns to join and removes the old link', async ({ page }) => {
  await setup(page)
  await page.goto('/')
  await join(page)
  await page.route('https://api.example.test/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }))
  await expect(page.getByRole('alert')).toHaveText('Your session expired. Enter the code again.')
  await expect(page.getByRole('button', { name: 'Join room', exact: true })).toBeVisible()
  await expect(page.locator('#room')).toBeHidden()
})

test('hiding a sharing phone releases its lease and camera', async ({ page }) => {
  const calls = await setup(page, { phone: true, active: false })
  await page.goto('/')
  await join(page)
  await page.getByRole('button', { name: 'Share camera', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible()
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => calls.some((call) => call.action === 'release')).toBe(true)
  await expect.poll(() => page.evaluate(() => window.roomTest.stops)).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Stop sharing' })).toBeHidden()
})
