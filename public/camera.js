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

// Decode original camera frames off the UI thread, with at most one in flight.
// Reports { url, location, width, height } (url is '' for non-web codes) or null.
export function scan(video, report) {
  const worker = new Worker(new URL('./qr-worker.js', import.meta.url))
  let ready = false, busy = false, stopped = false, bitmaps = false, last = -1
  let canvas, context
  worker.onmessage = ({ data }) => {
    if (stopped) return
    if (data.type === 'ready') {
      ready = true
      bitmaps = data.bitmaps && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function'
    } else if (data.type === 'result') {
      busy = false
      if (data.error) { bitmaps = false; return }
      const qr = data.qr
      report(qr ? { url: safeQRLink(qr.data), location: qr.location, width: data.width, height: data.height } : null)
    }
  }
  const timer = setInterval(async () => {
    if (!ready || busy || stopped || video.readyState < 2 || video.currentTime === last) return
    const width = video.videoWidth, height = video.videoHeight
    if (!width || !height) return
    last = video.currentTime
    busy = true
    let bitmap
    try {
      if (bitmaps) {
        // Transfer the original frame; drawing and pixel readback also happen
        // in the worker on browsers with OffscreenCanvas support.
        bitmap = await createImageBitmap(video)
        if (stopped) { bitmap.close(); return }
        worker.postMessage({ bitmap, width, height }, [bitmap])
      } else {
        // Older browsers still decode in the worker, using transferred pixels.
        canvas ??= document.createElement('canvas')
        context ??= canvas.getContext('2d', { willReadFrequently: true })
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height })
        context.drawImage(video, 0, 0)
        const pixels = context.getImageData(0, 0, width, height).data
        worker.postMessage({ pixels, width, height }, [pixels.buffer])
      }
    } catch {
      bitmap?.close()
      busy = false
      bitmaps = false
    }
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
