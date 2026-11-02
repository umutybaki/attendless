import { test, expect } from './fixtures.js'

test('the scanner reads original camera pixels when the viewer preview loses the QR detail', async ({ page }) => {
  await page.goto('/')
  await page.addScriptTag({ url: '/vendor/qrcode.js' })
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
