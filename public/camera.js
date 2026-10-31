import { safeQRLink } from './rtc.js'
import { projector } from './demo.js'

const failure = (kind) => Object.assign(new Error(kind), { kind })

// Opens the rear camera with whatever torch and zoom it supports.
// Demo mode films a projected slide instead.
export async function openCamera({ demo = false } = {}) {
  if (demo) return demoCamera()
  if (!navigator.mediaDevices?.getUserMedia) throw failure('missing')
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    })
  } catch (e) {
    throw failure(['NotFoundError', 'OverconstrainedError'].includes(e?.name) ? 'missing' : 'blocked')
  }
  const track = stream.getVideoTracks()[0]
  const caps = track.getCapabilities?.() ?? {}
  const zooms = caps.zoom ? [1, 2, 3].filter((zoom) => zoom >= caps.zoom.min && zoom <= caps.zoom.max) : []
  return {
    stream,
    track,
    torch: Boolean(caps.torch),
    zooms: zooms.length > 1 ? zooms : [],
    setTorch: (on) => track.applyConstraints({ advanced: [{ torch: on }] }),
    setZoom: (zoom) => track.applyConstraints({ advanced: [{ zoom }] }),
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  }
}

async function demoCamera() {
  const slide = await projector()
  return {
    stream: slide.stream,
    track: slide.stream.getVideoTracks()[0],
    torch: true,
    zooms: [1, 2, 3],
    setTorch: async (on) => slide.setTorch(on),
    setZoom: async (zoom) => slide.setZoom(zoom),
    stop: () => slide.stop(),
  }
}

// Reads QR codes from full-resolution frames up to 10 times a second.
// Reports { url, location, width, height } (url is '' for non-web codes) or null.
export function scan(video, report) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  let last = -1
  const timer = setInterval(() => {
    if (!window.jsQR || video.readyState < 2 || video.currentTime === last) return
    last = video.currentTime
    const width = (canvas.width = video.videoWidth), height = (canvas.height = video.videoHeight)
    if (!width || !height) return
    context.drawImage(video, 0, 0)
    const pixels = context.getImageData(0, 0, width, height)
    const qr = window.jsQR(pixels.data, width, height, { inversionAttempts: 'dontInvert' })
    report(qr ? { url: safeQRLink(qr.data), location: qr.location, width, height } : null)
  }, 100)
  return () => clearInterval(timer)
}

// Samples the feed into small JPEG frames for the same-browser room transport.
export function relay(video, send, { width = 540, fps = 8 } = {}) {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  let encoding = false
  const timer = setInterval(() => {
    if (encoding || video.readyState < 2 || !video.videoWidth) return
    const height = Math.round((width * video.videoHeight) / video.videoWidth)
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height })
    context.drawImage(video, 0, 0, width, height)
    encoding = true
    canvas.toBlob((blob) => {
      encoding = false
      if (blob) send(blob)
    }, 'image/jpeg', 0.72)
  }, 1000 / fps)
  return () => clearInterval(timer)
}

// Turns relayed frames back into a stream a <video> element can play.
export function framePlayer() {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  return {
    stream: canvas.captureStream?.() ?? null,
    async draw(blob) {
      const bitmap = await createImageBitmap(blob)
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height)
        Object.assign(canvas, { width: bitmap.width, height: bitmap.height })
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
    },
  }
}
