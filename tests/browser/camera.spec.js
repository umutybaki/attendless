import { test, expect } from './fixtures.js'

for (const fallback of [false, true]) test(`the scanner reads original camera pixels when the viewer preview loses the QR detail (${fallback ? 'pixel fallback' : 'bitmap worker'})`, async ({ page }) => {
  if (fallback) await page.addInitScript(() => { window.OffscreenCanvas = undefined })
  await page.goto('/')
  await page.addScriptTag({ url: '/vendor/qrcode.js' })
  await page.addScriptTag({ url: '/vendor/jsQR.js' })
  const result = await page.evaluate(async () => {
    const { scan, relay } = await import('/camera.js')
    const url = 'https://forms.example.com/r/FULLRESOLUTION123456789'
    const qr = window.qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const source = Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 })
    const context = source.getContext('2d')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, source.width, source.height)
    context.fillStyle = '#000'
    for (let row = 0; row < qr.getModuleCount(); row++)
      for (let col = 0; col < qr.getModuleCount(); col++)
        if (qr.isDark(row, col)) context.fillRect(900 + col * 2, 500 + row * 2, 2, 2)
    const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: source.captureStream(10) })
    video.style.width = '200px'
    document.body.append(video)
    await video.play()
    let stopScan, stopRelay
    try {
      const scanned = new Promise((resolve) => { stopScan = scan(video, (result) => { if (result) resolve(result) }) })
      const preview = new Promise((resolve) => { stopRelay = relay(video, resolve) })
      const [full, blob] = await Promise.all([scanned, preview])
      const bitmap = await createImageBitmap(blob)
      const reduced = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height })
      const pixels = reduced.getContext('2d')
      pixels.drawImage(bitmap, 0, 0)
      const decoded = window.jsQR(pixels.getImageData(0, 0, reduced.width, reduced.height).data, reduced.width, reduced.height)
      bitmap.close()
      return { url: full.url, width: full.width, height: full.height, previewWidth: reduced.width, previewQR: decoded?.data ?? null }
    } finally {
      stopScan?.()
      stopRelay?.()
      video.srcObject.getTracks().forEach((track) => track.stop())
      video.remove()
    }
  })
  expect(result).toEqual({
    url: 'https://forms.example.com/r/FULLRESOLUTION123456789',
    width: 1920, height: 1080, previewWidth: 540, previewQR: null,
  })
})

test('zoom and end stay responsive during a slow decode, with no scan backlog or worker left running', async ({ page }) => {
  // Simulate a slow phone decoding a large frame. The diagnostic message lets
  // the test interact while decoding is still running, rather than between scans.
  await page.route('**/vendor/jsQR.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `self.jsQR = () => {
      self.postMessage({ type: 'decoding' });
      const until = performance.now() + 2000;
      while (performance.now() < until) {}
      return null;
    };`,
  }))
  await page.addInitScript(() => {
    window.scanner = { decoding: 0, completed: 0, frames: 0, terminated: 0 }
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args)
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'decoding') window.scanner.decoding++
          if (data.type === 'result') window.scanner.completed++
        })
      }
      postMessage(...args) { window.scanner.frames++; return super.postMessage(...args) }
      terminate() { window.scanner.terminated++; return super.terminate() }
    }
  })
  await page.goto('/?demo')
  await page.getByRole('button', { name: 'New room' }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.scanner.decoding)).toBe(1)
  for (const zoom of [2, 3, 1]) {
    const button = page.locator(`[data-zoom="${zoom}"]`)
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
  }
  await page.getByRole('button', { name: 'End', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Tap to end', exact: true })).toBeVisible()
  // All of the controls responded before the deliberately slow scan finished,
  // and the 100 ms sampling loop did not send it any extra frames.
  expect(await page.evaluate(() => window.scanner)).toEqual({ decoding: 1, completed: 0, frames: 1, terminated: 0 })
  await page.getByRole('button', { name: 'Tap to end', exact: true }).click()
  await expect(page.locator('#home')).toBeVisible()
  expect(await page.evaluate(() => window.scanner.terminated)).toBe(1)
})
