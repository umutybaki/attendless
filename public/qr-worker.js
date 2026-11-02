// jsQR's full-resolution search is CPU intensive. Keep it away from input,
// rendering and camera controls, and return only the small decoded result.
importScripts('./vendor/jsQR.js')

let canvas, context
self.onmessage = ({ data: { bitmap, pixels, width, height } }) => {
  try {
    if (bitmap) {
      try {
        canvas ??= new OffscreenCanvas(width, height)
        context ??= canvas.getContext('2d', { willReadFrequently: true })
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height })
        context.drawImage(bitmap, 0, 0)
        pixels = context.getImageData(0, 0, width, height).data
      } finally {
        bitmap.close()
      }
    }
    const qr = self.jsQR(pixels, width, height, { inversionAttempts: 'dontInvert' })
    self.postMessage({ type: 'result', qr: qr ? { data: qr.data, location: qr.location } : null, width, height })
  } catch {
    self.postMessage({ type: 'result', error: true })
  }
}
self.postMessage({ type: 'ready', bitmaps: typeof OffscreenCanvas === 'function' })
