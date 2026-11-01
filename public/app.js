import { isSharingPhone, safeQRLink } from './rtc.js'
import { hostRoom, joinRoom } from './room.js'
import { openCamera, scan } from './camera.js'
import { demoRoom, crowd } from './demo.js'
import { track } from './analytics.js'

const messages = {
  "idle": "Type the six digits you were given.",
  "checking": "Looking for room {code}…",
  "notFound": "No room with code {code}. Check the digits.",
  "unreachable": "Couldn’t reach Attendless. Check your connection and try again.",
  "full": "This room has 10 viewers. Try again when someone leaves.",
  "limited": "Too many attempts. Wait a minute and try again.",
  "creating": "Creating a room…",
  "copied": "Copied",
  "shareText": "Join my Attendless room: {code}",
  "live": "Live",
  "watching": "{n} watching",
  "joined": "Someone joined",
  "end": "End",
  "endConfirm": "Tap to end",
  "starting": "Starting camera…",
  "aim": "Point at a QR code",
  "notLink": "Not a web link",
  "blocked": "Camera is blocked",
  "blockedHint": "Allow camera access for this site, then try again.",
  "interrupted": "Camera stopped",
  "interruptedHint": "Start the camera again to resume sharing.",
  "missing": "No camera found",
  "missingHint": "Open this page on a phone to share its camera.",
  "retry": "Try again",
  "paused": "Paused",
  "pausedHint": "Viewers see a paused screen. The last link stays.",
  "resume": "Resume",
  "pause": "Pause camera",
  "waiting": "Waiting",
  "waitingTitle": "Waiting for the camera",
  "waitingHint": "The feed starts when the host turns their camera on.",
  "viewerPaused": "Camera paused",
  "viewerPausedHint": "The last link stays below.",
  "offline": "Camera disconnected",
  "offlineHint": "The feed comes back here when the host returns.",
  "ended": "Room ended",
  "endedHint": "The host closed room {code}.",
  "home": "Back to start",
  "latest": "Latest link",
  "lastScan": "Sent to viewers",
  "scannedAgo": "Scanned {t} ago",
  "newLink": "New link"
}

const params = new URLSearchParams(location.search)
const demo = params.has('demo')
const phone = isSharingPhone(navigator)
const $ = (id) => document.getElementById(id)
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => values[key])
const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const buzz = (pattern) => navigator.vibrate?.(pattern)
const app = $('app'), video = $('feed'), reticle = $('reticle')
const title = 'Attendless'

const fresh = () => ({
  view: 'home', role: '', digits: '', entry: 'idle', code: '',
  live: false, paused: false, offline: false, ended: false, viewers: 0, extra: 0,
  starting: false, cameraError: '', link: null, torch: false, zoom: 1,
  armed: false, invite: false, lock: '', full: false, limited: false,
})
const state = fresh()
let room = null, camera = null, stops = [], wakeLock = null, autoPaused = false
let armTimer = 0, lostAt = 0, typed = -1
// The camera's totals for its room, reported once when the camera leaves it.
let stats = null
// Events already sent for the current room, and whether a failed join was reported this page.
let reported = new Set(), joinFailed = false
// Aptabase's free plan counts events, so most are sent at most once per room.
const once = (name, props, options) => {
  if (reported.has(name)) return
  reported.add(name)
  track(name, props, options)
}

// Reloading keeps you in your room; closing the tab forgets it.
const memory = {
  get() { try { return JSON.parse(sessionStorage.getItem('attendless.room')) } catch { return null } },
  set(value) {
    try { value ? sessionStorage.setItem('attendless.room', JSON.stringify(value)) : sessionStorage.removeItem('attendless.room') } catch { /* Private mode: no restore. */ }
  },
}

$('demo-badge').hidden = !demo

// ---------- Rendering ----------

function render() {
  app.dataset.view = state.view
  app.dataset.role = state.role
  $('home').hidden = state.view !== 'home'
  $('room').hidden = state.view !== 'room'
  if (state.view === 'home') renderHome()
  else renderRoom()
  $('invite').hidden = !state.invite
}

function renderHome() {
  const slots = $('code').querySelectorAll('.slot')
  slots.forEach((slot, i) => {
    slot.textContent = state.digits[i] ?? ''
    slot.classList.toggle('next', state.entry === 'idle' && i === state.digits.length)
    slot.classList.toggle('pop', i === typed)
  })
  typed = -1
  $('code').dataset.state = state.entry
  $('home-status').textContent =
    state.entry === 'checking' || state.entry === 'locked' ? fill(messages.checking, { code: spaced(state.digits) })
    : state.entry === 'creating' ? messages.creating
    : state.entry === 'error' ? (state.full ? messages.full : state.limited ? messages.limited : state.unreachable ? messages.unreachable : fill(messages.notFound, { code: spaced(state.digits) }))
    : messages.idle
  for (const key of document.querySelectorAll('.key')) key.disabled = busy()
}

function renderRoom() {
  const isCamera = state.role === 'camera'
  const viewers = state.viewers + state.extra
  $('room-code-text').textContent = spaced(state.code)

  const presence = state.ended ? 'ended' : state.offline ? 'offline' : state.paused ? 'paused' : state.live ? 'live' : 'waiting'
  $('presence').dataset.presence = presence
  $('presence-text').textContent = isCamera
    ? (state.live || state.paused ? fill(messages.watching, { n: viewers }) : messages.waiting)
    : presence === 'live' ? `${messages.live} · ${viewers}` : presence === 'paused' ? messages.paused : messages.waiting

  const note = stageNote()
  $('stage').dataset.note = note ? note.kind : ''
  $('note').hidden = !note
  if (note) {
    $('note-title').textContent = note.title
    $('note-hint').textContent = note.hint ?? ''
    $('note-action').hidden = !note.action
    $('note-action').textContent = note.action ? messages[note.action] : ''
    $('note-action').dataset.action = note.action ?? ''
  }

  const link = state.link
  $('link').dataset.empty = String(!link)
  $('link-eyebrow').textContent = isCamera ? messages.lastScan : messages.latest
  if (link && $('link-open').href !== link.url) {
    const url = new URL(link.url)
    let path = url.pathname + url.search + url.hash
    try { path = decodeURI(path) } catch { /* Keep the encoded form. */ }
    $('link-open').href = link.url
    $('link-host').textContent = url.hostname.replace(/^www\./, '')
    $('link-path').textContent = path === '/' ? url.origin : path
    $('link-path').title = link.url
  }
  tickAge()

  $('end').dataset.armed = String(state.armed)
  $('end').textContent = state.armed ? messages.endConfirm : messages.end
  $('torch').hidden = !camera?.torch
  $('torch').setAttribute('aria-pressed', String(state.torch))
  $('pause').setAttribute('aria-pressed', String(state.paused))
  $('pause').querySelector('use').setAttribute('href', state.paused ? '#i-play' : '#i-pause')
  $('pause').setAttribute('aria-label', state.paused ? messages.resume : messages.pause)
  $('pause').disabled = !state.live && !state.paused
  for (const button of $('zoom').children) button.setAttribute('aria-pressed', String(Number(button.dataset.zoom) === state.zoom))

  reticle.dataset.lock = state.lock
  $('reticle-label').textContent =
    state.lock === 'link' ? new URL(state.link.url).hostname.replace(/^www\./, '')
    : state.lock === 'text' ? messages.notLink
    : state.live && !state.link ? messages.aim : ''
}

function stageNote() {
  if (state.role === 'camera') {
    if (state.cameraError) return { kind: 'error', title: messages[state.cameraError], hint: messages[`${state.cameraError}Hint`], action: 'retry' }
    if (state.starting) return { kind: 'starting', title: messages.starting }
    if (state.paused) return { kind: 'paused', title: messages.paused, hint: messages.pausedHint, action: 'resume' }
    return null
  }
  if (state.ended) return { kind: 'ended', title: messages.ended, hint: fill(messages.endedHint, { code: spaced(state.code) }), action: 'home' }
  if (state.offline) return { kind: 'offline', title: messages.offline, hint: messages.offlineHint }
  if (state.paused) return { kind: 'paused', title: messages.viewerPaused, hint: messages.viewerPausedHint }
  if (!state.live) return { kind: 'waiting', title: messages.waitingTitle, hint: messages.waitingHint }
  return null
}

// The age of the link is the one number a viewer needs: rotating QR codes expire.
function tickAge() {
  if (!state.link) return
  const seconds = Math.max(0, Math.floor((Date.now() - state.link.scannedAt) / 1000))
  const clock = seconds >= 3600 ? '59:59+' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  $('link-age').textContent = clock
  $('link-age').dateTime = `PT${seconds}S`
  $('link-age').title = fill(messages.scannedAgo, { t: clock })
  $('link').classList.toggle('fresh', seconds < 15)
}
setInterval(tickAge, 1000)

function flash(element, className = 'flash', ms = 1200) {
  element.classList.remove(className)
  void element.offsetWidth
  element.classList.add(className)
  clearTimeout(element.flashTimer)
  element.flashTimer = setTimeout(() => element.classList.remove(className), ms)
}

function toast(text) {
  const element = $('toast')
  element.textContent = text
  element.hidden = false
  element.style.animation = 'none'
  void element.offsetWidth
  element.style.animation = ''
  clearTimeout(element.timer)
  element.timer = setTimeout(() => { element.hidden = true }, 1800)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text })
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  toast(messages.copied)
}

// ---------- Home: typing a code ----------

const busy = () => ['checking', 'locked', 'creating'].includes(state.entry)

function press(digit) {
  if (state.view !== 'home' || busy()) return
  if (state.entry === 'error') Object.assign(state, { entry: 'idle', digits: '' })
  if (state.digits.length >= 6) return
  typed = state.digits.length
  state.digits += digit
  render()
  if (state.digits.length === 6) void join(state.digits, '', 'code')
}

function erase(all = false) {
  if (state.entry !== 'idle' && state.entry !== 'error') return
  state.digits = all || state.entry === 'error' ? '' : state.digits.slice(0, -1)
  state.entry = 'idle'
  render()
}

async function join(code, token, via) {
  Object.assign(state, { entry: 'checking', digits: code, unreachable: false, full: false, limited: false })
  render()
  let next
  try {
    next = (await joinRoom(code, token)) ?? (demo ? await demoRoom(code) : null)
  } catch (error) {
    next = demo ? await demoRoom(code) : null
    state.full = error.status === 409
    state.limited = error.status === 429
    state.unreachable = !demo && !state.full
  }
  if (state.view !== 'home' || state.digits !== code) return next?.leave()
  if (!next) {
    state.entry = 'error'
    if (!state.unreachable && !state.full) memory.set(null)
    render()
    buzz([30, 40, 30])
    // Typos repeat; the first failure per visit is enough to see the problem.
    if (!joinFailed) track('join_failed', { via, reason: state.full ? 'full' : state.unreachable ? 'unreachable' : 'not_found' })
    joinFailed = true
    return
  }
  reported = new Set()
  // A reload rejoins the same room: not a new join.
  if (via !== 'reload') track('room_joined', { via, lang: 'en' })
  state.entry = 'locked'
  render()
  await wait(360)
  enterViewer(next)
}

// ---------- Viewer ----------

function enterViewer(next) {
  room = next
  const { state: initial, link } = next.welcomed
  Object.assign(state, fresh(), { view: 'room', role: 'viewer', code: next.code }, pick(initial))
  if (link) receive(link, false)
  if (next.stream) show(next.stream)
  room.addEventListener('stream', (event) => show(event.detail))
  room.addEventListener('state', (event) => {
    const before = state.viewers
    Object.assign(state, pick(event.detail))
    if (state.viewers > before) flash($('presence'), 'bump', 400)
    render()
  })
  room.addEventListener('link', (event) => receive(event.detail, true))
  room.addEventListener('ended', () => {
    state.ended = true
    memory.set(null)
    render()
  })
  memory.set({ code: next.code, role: 'viewer', token: next.token })
  room.start()
  render()
}

const pick = (s = {}) => ({ live: Boolean(s.live), paused: Boolean(s.paused), offline: Boolean(s.offline), viewers: s.viewers ?? 0 })

function receive(link, announce) {
  const url = safeQRLink(link?.url)
  if (!url || !Number.isFinite(link.scannedAt) || (state.link && link.scannedAt <= state.link.scannedAt)) return
  state.link = { url, scannedAt: link.scannedAt }
  render()
  if (!announce) return
  flash($('link'))
  buzz(40)
  if (document.hidden) document.title = `● ${messages.newLink} · ${title}`
}

// ---------- Camera ----------

async function enterCamera(saved) {
  if (busy() || state.view !== 'home') return
  Object.assign(state, { entry: 'creating', digits: '', unreachable: false, full: false, limited: false })
  render()
  try {
    room = await hostRoom(saved)
  } catch (error) {
    if (error.status === 410) {
      memory.set(null)
      Object.assign(state, fresh())
      render()
      return toast(messages.ended)
    }
    Object.assign(state, { entry: 'error', unreachable: true, limited: error.status === 429 })
    return render()
  }
  const viewers = typeof room.viewers === 'number' ? room.viewers : 0
  Object.assign(state, fresh(), { view: 'room', role: 'camera', code: room.code, invite: !saved, viewers })
  stats = { created: saved?.created ?? Date.now(), started: 0, links: 0, peak: viewers, firstLink: -1 }
  reported = new Set()
  memory.set({ code: room.code, role: 'camera', token: room.token, created: stats.created })
  if (!saved) track('room_created', { lang: 'en' })
  room.addEventListener('viewers', (event) => setViewers(event.detail, state.extra))
  room.addEventListener('ended', () => {
    exit('ended')
    toast(messages.ended)
  })
  if (demo) stops.push(crowd((n) => setViewers(state.viewers, n)))
  $('invite-code').textContent = spaced(room.code)
  render()
  rest()
  void startCamera()
}

function setViewers(real, extra) {
  const before = state.viewers + state.extra
  Object.assign(state, { viewers: real, extra })
  if (stats) stats.peak = Math.max(stats.peak, real + extra)
  if (real + extra > before) {
    flash($('presence'), 'bump', 400)
    toast(messages.joined)
  }
  render()
}

async function startCamera() {
  if (state.starting || state.role !== 'camera') return
  const owner = room
  Object.assign(state, { starting: true, cameraError: '' })
  render()
  let opened
  try {
    opened = await openCamera({ demo })
  } catch (e) {
    if (room !== owner) return
    Object.assign(state, { starting: false, cameraError: e.kind ?? 'blocked' })
    once('camera_failed', { reason: state.cameraError })
    return render()
  }
  if (state.role !== 'camera' || room !== owner) return opened.stop()
  camera?.stop()
  camera = opened
  stats.started ||= Date.now()
  show(camera.stream)
  $('zoom').replaceChildren(...camera.zooms.map((zoom) => {
    const button = Object.assign(document.createElement('button'), { textContent: `${zoom}×` })
    button.dataset.zoom = zoom
    return button
  }))
  Object.assign(state, { starting: false, live: true, paused: false, zoom: 1, torch: false })
  room.publish(camera.stream, video)
  const stopScan = scan(video, seen)
  stops.push(stopScan)
  camera.track.addEventListener('ended', () => {
    if (room !== owner || camera !== opened) return
    stopScan()
    room.unpublish()
    Object.assign(state, { live: false, paused: false, cameraError: 'interrupted', lock: '' })
    void wakeLock?.release().catch(() => {})
    render()
  }, { once: true })
  void keepAwake()
  render()
  requestAnimationFrame(rest)
}

// Every scan result moves the reticle: onto the code while it is in view, back to rest after.
function seen(result) {
  if (state.paused || state.role !== 'camera') return
  if (!result) {
    if (state.lock && !lostAt) lostAt = Date.now()
    if (state.lock && Date.now() - lostAt > 600) {
      state.lock = ''
      rest()
      render()
    }
    return
  }
  lostAt = 0
  frame(result)
  const lock = result.url ? 'link' : 'text'
  const isNew = result.url && result.url !== state.link?.url
  if (isNew) {
    // Rotating codes produce a link every few seconds: the summary counts them and times the first.
    if (++stats.links === 1) stats.firstLink = Math.round((Date.now() - stats.started) / 1000)
    state.link = { url: result.url, scannedAt: Date.now() }
    room.sendLink(state.link)
    flash($('link'))
    buzz(25)
  }
  if (isNew || lock !== state.lock) {
    state.lock = lock
    render()
  }
}

function frame({ location, width, height }) {
  const box = $('stage').getBoundingClientRect()
  const scale = Math.max(box.width / width, box.height / height)
  const dx = (box.width - width * scale) / 2, dy = (box.height - height * scale) / 2
  const corners = [location.topLeftCorner, location.topRightCorner, location.bottomLeftCorner, location.bottomRightCorner]
  const xs = corners.map((p) => p.x * scale + dx), ys = corners.map((p) => p.y * scale + dy)
  const pad = 14
  place(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2)
}

// At rest the reticle sits in the clear band between the bar and the dock.
function rest() {
  if (state.role !== 'camera') return
  const box = $('stage').getBoundingClientRect()
  const top = document.querySelector('.room-bar').getBoundingClientRect().bottom
  const bottom = document.querySelector('.dock').getBoundingClientRect().top
  const size = Math.max(120, Math.min(box.width * 0.64, (bottom - top) * 0.62, 300))
  place((box.width - size) / 2, (top + bottom) / 2 - size / 2 - 12, size, size)
}

function place(x, y, width, height) {
  reticle.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  reticle.style.width = `${Math.round(width)}px`
  reticle.style.height = `${Math.round(height)}px`
}

function pause(paused) {
  if (!camera) return
  state.paused = paused
  state.lock = ''
  camera.track.enabled = !paused
  room.setState({ live: !paused, paused })
  if (paused) void wakeLock?.release().catch(() => {})
  else void keepAwake()
  render()
  if (!paused) rest()
}

async function keepAwake() {
  if (state.role !== 'camera' || !state.live || state.paused || document.hidden || (wakeLock && !wakeLock.released)) return
  const owner = room
  try {
    const lock = await navigator.wakeLock?.request('screen')
    if (room !== owner || state.paused || !state.live || document.hidden) await lock?.release()
    else wakeLock = lock
  } catch { /* The screen may sleep. */ }
}

function arm() {
  if (state.armed) {
    return exit('end')
  }
  state.armed = true
  render()
  clearTimeout(armTimer)
  armTimer = setTimeout(() => { state.armed = false; render() }, 3000)
}

// ---------- Shared room pieces ----------

function show(stream) {
  video.srcObject = stream
  void video.play().catch(() => {})
}

function inviteUrl() {
  const url = new URL(location.pathname, location.origin)
  url.searchParams.set('room', state.code)
  if (demo) url.searchParams.set('demo', '')
  return url.href
}


function openInvite() {
  $('invite-code').textContent = spaced(state.code)
  state.invite = true
  render()
  $('invite-done').focus()
}

// One event sums up the camera's room: how it closed, how long it ran, how many
// links it sent, how many people watched. It replaces an event per milestone.
function summarize(how) {
  if (state.role !== 'camera' || !stats) return
  const props = { how, minutes: Math.round((Date.now() - stats.created) / 60000), links: stats.links, peak_viewers: stats.peak }
  if (stats.firstLink >= 0) props.first_link_seconds = stats.firstLink
  once('room_closed', props, { closing: how === 'close' })
}

// how: 'end' (the End button), 'leave' (the close button), 'ended' (the server closed the room).
function exit(how = 'leave') {
  summarize(how)
  if (how === 'end') room?.end()
  else room?.leave?.()
  stops.forEach((stop) => stop())
  camera?.stop()
  void wakeLock?.release().catch(() => {})
  video.srcObject = null
  room = camera = wakeLock = stats = null
  autoPaused = false
  stops = []
  clearTimeout(armTimer)
  memory.set(null)
  Object.assign(state, fresh())
  document.title = title
  render()
}

// ---------- Input ----------

for (const key of document.querySelectorAll('[data-digit]')) key.addEventListener('click', () => press(key.dataset.digit))
$('erase').addEventListener('click', () => erase())
$('new-room').addEventListener('click', () => void enterCamera())
$('leave').addEventListener('click', () => exit())
$('end').addEventListener('click', arm)
$('room-code').addEventListener('click', openInvite)
$('note-action').addEventListener('click', (event) => {
  const action = event.currentTarget.dataset.action
  if (action === 'retry') void startCamera()
  if (action === 'resume') pause(false)
  if (action === 'home') exit()
})
$('pause').addEventListener('click', () => pause(!state.paused))
$('torch').addEventListener('click', async () => {
  try {
    await camera?.setTorch(!state.torch)
    state.torch = !state.torch
  } catch { /* The track refused; leave the button as it was. */ }
  render()
})
$('zoom').addEventListener('click', async (event) => {
  const zoom = Number(event.target.closest('[data-zoom]')?.dataset.zoom)
  if (!zoom || !camera) return
  try {
    await camera.setZoom(zoom)
    state.zoom = zoom
  } catch { /* Unsupported step. */ }
  render()
})
$('link-open').addEventListener('click', () => once('link_opened', { action: 'open', role: state.role }))
$('link-copy').addEventListener('click', () => {
  if (!state.link) return
  once('link_opened', { action: 'copy', role: state.role })
  copyText(state.link.url)
})
$('invite-copy').addEventListener('click', () => {
  once('invite_shared', { method: 'copy', role: state.role })
  copyText(inviteUrl())
})
$('invite-share').addEventListener('click', async () => {
  const data = { title, text: fill(messages.shareText, { code: spaced(state.code) }), url: inviteUrl() }
  const share = Boolean(navigator.canShare?.(data))
  once('invite_shared', { method: share ? 'share' : 'copy', role: state.role })
  if (share) return navigator.share(data).catch(() => {})
  copyText(data.url)
})
for (const element of document.querySelectorAll('[data-close]')) element.addEventListener('click', () => { state.invite = false; render() })

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (state.invite && event.key === 'Escape') { state.invite = false; return render() }
  if (state.view !== 'home') return
  if (/^\d$/.test(event.key)) {
    event.preventDefault()
    press(event.key)
    flash(document.querySelector(`[data-digit="${event.key}"]`), 'pressed', 120)
  } else if (event.key === 'Backspace') {
    erase()
    flash($('erase'), 'pressed', 120)
  } else if (event.key === 'Escape') erase(true)
})
document.addEventListener('paste', (event) => {
  const match = (event.clipboardData?.getData('text') ?? '').match(/(\d{3})\s?(\d{3})/)
  if (state.view !== 'home' || !match || busy()) return
  event.preventDefault()
  Object.assign(state, { entry: 'idle', digits: '' })
  for (const digit of match[1] + match[2]) press(digit)
})

// An app, not a page: no pinch zoom, no double-tap zoom, no rubber-band scroll.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (event) => event.preventDefault())
document.addEventListener('touchmove', (event) => { if (event.touches.length > 1) event.preventDefault() }, { passive: false })
document.addEventListener('dblclick', (event) => event.preventDefault())

window.addEventListener('resize', () => { if (!state.lock) rest() })
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    document.title = title
    if (autoPaused) { autoPaused = false; pause(false) }
    void keepAwake()
  } else if (phone && state.role === 'camera' && state.live && !state.paused) {
    // Phones freeze a hidden camera anyway; say so instead of showing a stuck frame.
    autoPaused = true
    pause(true)
  }
})
// Leaving frees the camera slot or viewer seat now; a reload restores the room from memory.
// The summary goes out with keepalive; a reload sends one too and the restored page starts a new one.
window.addEventListener('pagehide', () => {
  summarize('close')
  room?.leave()
})
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })

// ---------- Start: restore a room, follow an invite link, or show the keypad ----------

const saved = memory.get()
const invited = (params.get('room') ?? '').replace(/\D/g, '')
if (params.has('room') || params.has('lang')) {
  params.delete('room')
  params.delete('lang')
  const query = params.toString().replace(/(^|&)demo=(?=&|$)/, '$1demo')
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`)
}
const restoring = /^\d{6}$/.test(saved?.code ?? '') && ['camera', 'viewer'].includes(saved.role)
if (invited.length === 6 && (!restoring || saved.code !== invited)) void join(invited, '', 'invite')
else if (restoring && saved.role === 'camera') void enterCamera(saved)
else if (restoring) void join(saved.code, saved.token, 'reload')
else if (invited.length === 6) void join(invited, '', 'invite')
else render()
