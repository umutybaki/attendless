// jsQR's search is CPU intensive. Keep it away from input, rendering and
// camera controls, and return only the small decoded result.
importScripts('./vendor/jsQR.js')

self.onmessage = ({ data: { pixels, width, height } }) => {
  let qr = null
  try {
    qr = self.jsQR(pixels, width, height, { inversionAttempts: 'dontInvert' })
  } catch { /* An unreadable frame counts as no code; the next one is scanned. */ }
  self.postMessage({ type: 'result', qr: qr ? { data: qr.data, location: qr.location } : null })
}
self.postMessage({ type: 'ready' })
