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
        width: { ideal: 3840 },
        height: { ideal: 2160 },
        resizeMode: { ideal: 'none' },
        frameRate: { ideal: 30, max: 30 },
      },
    })
  } catch (e) {
    throw failure(['NotFoundError', 'OverconstrainedError'].includes(e?.name) ? 'missing' : 'blocked')
  }
  const track = stream.getVideoTracks()[0]
  const caps = track.getCapabilities?.() ?? {}
  // Capture as much detail as this camera supports; viewer limits belong to
  // the encoder, never the source that the QR scanner reads.
  if (caps.width?.max && caps.height?.max) {
    try {
      await track.applyConstraints({
        ...track.getConstraints(),
        width: { ideal: caps.width.max },
        height: { ideal: caps.height.max },
      })
    } catch { /* Keep the working capture if the browser cannot upgrade it. */ }
  }
  // applyConstraints replaces previous constraints, including the resolution.
  const adjust = (settings) => track.applyConstraints({ ...track.getConstraints(), advanced: [settings] })
  const zooms = caps.zoom ? [1, 2, 3].filter((zoom) => zoom >= caps.zoom.min && zoom <= caps.zoom.max) : []
  return {
    stream,
    track,
    torch: Boolean(caps.torch),
    zooms: zooms.length > 1 ? zooms : [],
    setTorch: (on) => adjust({ torch: on }),
    setZoom: (zoom) => adjust({ zoom }),
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

// jsQR slows down sharply with frame size, and phone sensor noise at 4K or
// 12 MP makes it search for many seconds and still miss. Each scan therefore
// reads at most SCAN_EDGE pixels along its long edge.
const SCAN_EDGE = 1280

// The part of the frame a scan reads: even passes take the whole view, scaled
// down (which also averages away noise); odd passes take the original pixels
// at the centre, for small or distant codes. Small frames are always read whole.
export function scanRegion(width, height, pass) {
  const scale = Math.min(1, SCAN_EDGE / Math.max(width, height))
  const w = Math.round(width * scale), h = Math.round(height * scale)
  if (pass % 2 === 0 || scale === 1) return { sx: 0, sy: 0, sw: width, sh: height, w, h }
  return { sx: Math.round((width - w) / 2), sy: Math.round((height - h) / 2), sw: w, sh: h, w, h }
}

// Decodes camera frames off the UI thread, with at most one in flight.
// Reports { url, location, width, height } (url is '' for non-web codes) or null;
// location is in the coordinates of the full width × height frame.
export function scan(video, report) {
  const worker = new Worker(new URL('./qr-worker.js', import.meta.url))
  // A plain 2D canvas crops and scales the frame on every browser, Safari
  // included. It stays GPU-backed (no willReadFrequently), so only the small
  // scan region is read back.
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  // A still frame is read at most once each way: tried has one bit per kind of pass.
  let ready = false, stopped = false, pending = null, pass = 0, last = -1, tried = 0
  worker.onmessage = ({ data }) => {
    if (stopped) return
    if (data.type === 'ready') { ready = true; return }
    if (data.type !== 'result') return
    const { region, width, height } = pending
    pending = null
    const qr = data.qr
    // Keep reading the same way while it finds the code; alternate after a miss.
    if (!qr) { pass++; return report(null) }
    const x = region.sw / region.w, y = region.sh / region.h
    const location = Object.fromEntries(Object.entries(qr.location).map(([name, p]) => [name, { x: region.sx + p.x * x, y: region.sy + p.y * y }]))
    report({ url: safeQRLink(qr.data), location, width, height })
  }
  const timer = setInterval(() => {
    if (!ready || pending || video.readyState < 2) return
    const width = video.videoWidth, height = video.videoHeight
    if (!width || !height) return
    if (video.currentTime !== last) { last = video.currentTime; tried = 0 }
    const kind = 1 << (pass % 2)
    if (tried & kind) return
    tried |= kind
    const region = scanRegion(width, height, pass)
    if (canvas.width !== region.w || canvas.height !== region.h) Object.assign(canvas, { width: region.w, height: region.h })
    context.imageSmoothingQuality = 'high'
    context.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, region.w, region.h)
    const pixels = context.getImageData(0, 0, region.w, region.h).data
    pending = { region, width, height }
    worker.postMessage({ pixels, width: region.w, height: region.h }, [pixels.buffer])
  }, 100)
  return () => {
    stopped = true
    clearInterval(timer)
    worker.terminate()
  }
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
