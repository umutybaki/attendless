// Demo mode (?demo) stands in for what one browser cannot provide by itself:
// a camera filming a projected slide whose QR link rotates, a host for any
// code you type, and a few viewers trickling into rooms you create.

const token = () => Math.random().toString(36).slice(2, 8).toUpperCase()

// The encoder only exists for the demo slide, so only demo mode downloads it.
let encoder
const loadEncoder = () => (encoder ??= new Promise((resolve, reject) => {
  document.head.append(Object.assign(document.createElement('script'), { src: './vendor/qrcode.js', onload: resolve, onerror: reject }))
}))

// One pixel per module, quiet zone included; draw it scaled with smoothing off.
function drawQR(canvas, text, quiet = 4) {
  const qr = window.qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount(), size = count + quiet * 2
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, size, size)
  context.fillStyle = '#000'
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++)
      if (qr.isDark(row, col)) context.fillRect(col + quiet, row + quiet, 1, 1)
}

// A portrait phone filming a landscape slide. The QR is real, so the scanner
// reads it exactly as it would read a camera frame.
export async function projector({ every = 12000 } = {}) {
  await loadEncoder()
  const canvas = Object.assign(document.createElement('canvas'), { width: 720, height: 1280 })
  const context = canvas.getContext('2d')
  const code = document.createElement('canvas')
  const listeners = new Set()
  let url = '', zoom = 1, shown = 1, torch = false
  const rotate = () => {
    url = `https://forms.example.com/r/${token()}`
    drawQR(code, url)
    listeners.forEach((listener) => listener(url))
  }
  const started = performance.now()
  const paint = () => {
    const t = performance.now() - started, { width: w, height: h } = canvas
    shown += (zoom - shown) * 0.18
    context.fillStyle = torch ? '#34312a' : '#14130f'
    context.fillRect(0, 0, w, h)
    const glow = context.createRadialGradient(w / 2, h * 0.42, 30, w / 2, h * 0.42, w * 0.9)
    glow.addColorStop(0, `rgba(255, 248, 225, ${torch ? 0.28 : 0.14})`)
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
    context.fillStyle = glow
    context.fillRect(0, 0, w, h)
    context.save()
    context.translate(w / 2 + Math.sin(t / 700) * 6 + Math.sin(t / 230) * 1.5, h * 0.42 + Math.cos(t / 900) * 5)
    context.scale(shown, shown)
    const sw = 620, sh = 349
    context.fillStyle = '#f3f2ec'
    context.fillRect(-sw / 2, -sh / 2, sw, sh)
    context.fillStyle = '#23221d'
    context.fillRect(-sw / 2 + 30, -sh / 2 + 40, 210, 20)
    context.fillStyle = '#bcbab0'
    for (let line = 0; line < 4; line++) context.fillRect(-sw / 2 + 30, -sh / 2 + 92 + line * 30, 220 - line * 26, 10)
    context.imageSmoothingEnabled = false
    const size = 262
    context.drawImage(code, sw / 2 - size - 32, -size / 2, size, size)
    context.restore()
    // Heads in the rows in front of the phone.
    context.fillStyle = '#0a0907'
    for (const [x, r] of [[90, 120], [330, 140], [560, 128], [740, 110]]) {
      context.beginPath()
      context.ellipse(x, h * 0.98, r, r * 1.6, 0, 0, Math.PI * 2)
      context.fill()
    }
  }
  rotate()
  paint()
  const painting = setInterval(paint, 1000 / 30), rotating = setInterval(rotate, every)
  const stream = canvas.captureStream(30)
  return {
    stream,
    get url() { return url },
    onLink: (listener) => listeners.add(listener),
    setZoom: (value) => { zoom = value },
    setTorch: (on) => { torch = on },
    stop() {
      clearInterval(painting)
      clearInterval(rotating)
      stream.getTracks().forEach((track) => track.stop())
    },
  }
}

// A host for any code nobody in this browser is hosting.
export async function demoRoom(code) {
  const room = new EventTarget()
  const slide = await projector()
  const emit = (type, detail) => room.dispatchEvent(new CustomEvent(type, { detail }))
  const timers = [
    setTimeout(() => emit('link', { url: slide.url, scannedAt: Date.now() }), 1600),
    setTimeout(() => emit('state', { live: true, paused: false, viewers: 5 }), 7000),
  ]
  slide.onLink((url) => timers.push(setTimeout(() => emit('link', { url, scannedAt: Date.now() }), 450)))
  return Object.assign(room, {
    code,
    stream: slide.stream,
    welcomed: { state: { live: true, paused: false, viewers: 4 }, link: null },
    start() {},
    leave() {
      timers.forEach(clearTimeout)
      slide.stop()
    },
  })
}

// Viewers who join a demo room you host, on top of any real tabs.
export function crowd(report) {
  const timers = [[6000, 1], [9000, 3], [14000, 4]].map(([delay, n]) => setTimeout(() => report(n), delay))
  return () => timers.forEach(clearTimeout)
}
