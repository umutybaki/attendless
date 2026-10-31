import { copy } from './copy.js'
import { isSharingPhone, safeQRLink } from './rtc.js'
import { hostRoom, joinRoom } from './room.js'
import { openCamera, scan, relay, framePlayer } from './camera.js'
import { demoRoom, crowd } from './demo.js'

const params = new URLSearchParams(location.search)
const locale = params.get('lang') === 'tr' ? 'tr' : 'en'
const demo = params.has('demo')
const phone = isSharingPhone(navigator)
const t = copy[locale]
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
  armed: false, invite: false, lock: '',
})
const state = fresh()
let room = null, camera = null, player = null, stops = [], wakeLock = null, autoPaused = false
let armTimer = 0, lostAt = 0, typed = -1

// Reloading keeps you in your room; closing the tab forgets it.
const memory = {
  get() { try { return JSON.parse(sessionStorage.getItem('attendless.room')) } catch { return null } },
  set(value) {
    try { value ? sessionStorage.setItem('attendless.room', JSON.stringify(value)) : sessionStorage.removeItem('attendless.room') } catch { /* Private mode: no restore. */ }
  },
}

for (const element of document.querySelectorAll('[data-copy]')) element.textContent = t[element.dataset.copy]
for (const element of document.querySelectorAll('[data-label]')) {
  element.setAttribute('aria-label', t[element.dataset.label])
  element.title = t[element.dataset.label]
}
document.documentElement.lang = locale
document.querySelector('meta[name="description"]').content = t.description
$('demo-badge').hidden = !demo
const other = new URLSearchParams(params)
other.delete('room')
locale === 'tr' ? other.delete('lang') : other.set('lang', 'tr')
$('language').href = `?${other}`
$('language').textContent = locale === 'tr' ? 'EN' : 'TR'
$('language').hreflang = $('language').lang = locale === 'tr' ? 'en' : 'tr'
$('language').setAttribute('aria-label', locale === 'tr' ? 'English' : 'Türkçe')

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
    state.entry === 'checking' || state.entry === 'locked' ? fill(t.checking, { code: spaced(state.digits) })
    : state.entry === 'error' ? fill(t.notFound, { code: spaced(state.digits) })
    : t.idle
  const busy = state.entry === 'checking' || state.entry === 'locked'
  for (const key of document.querySelectorAll('.key')) key.disabled = busy
}

function renderRoom() {
  const isCamera = state.role === 'camera'
  const viewers = state.viewers + state.extra
  $('room-code-text').textContent = spaced(state.code)

  const presence = state.ended ? 'ended' : state.offline ? 'offline' : state.paused ? 'paused' : state.live ? 'live' : 'waiting'
  $('presence').dataset.presence = presence
  $('presence-text').textContent = isCamera
    ? (state.live || state.paused ? fill(t.watching, { n: viewers }) : t.waiting)
    : presence === 'live' ? `${t.live} · ${viewers}` : presence === 'paused' ? t.paused : t.waiting

  const note = stageNote()
  $('stage').dataset.note = note ? note.kind : ''
  $('note').hidden = !note
  if (note) {
    $('note-title').textContent = note.title
    $('note-hint').textContent = note.hint ?? ''
    $('note-action').hidden = !note.action
    $('note-action').textContent = note.action ? t[note.action] : ''
    $('note-action').dataset.action = note.action ?? ''
  }

  const link = state.link
  $('link').dataset.empty = String(!link)
  $('link-eyebrow').textContent = isCamera ? t.lastScan : t.latest
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
  $('end').textContent = state.armed ? t.endConfirm : t.end
  $('torch').hidden = !camera?.torch
  $('torch').setAttribute('aria-pressed', String(state.torch))
  $('pause').setAttribute('aria-pressed', String(state.paused))
  $('pause').querySelector('use').setAttribute('href', state.paused ? '#i-play' : '#i-pause')
  $('pause').setAttribute('aria-label', state.paused ? t.resume : t.pause)
  $('pause').disabled = !state.live && !state.paused
  for (const button of $('zoom').children) button.setAttribute('aria-pressed', String(Number(button.dataset.zoom) === state.zoom))

  reticle.dataset.lock = state.lock
  $('reticle-label').textContent =
    state.lock === 'link' ? new URL(state.link.url).hostname.replace(/^www\./, '')
    : state.lock === 'text' ? t.notLink
    : state.live && !state.link ? t.aim : ''
}

function stageNote() {
  if (state.role === 'camera') {
    if (state.cameraError) return { kind: 'error', title: t[state.cameraError], hint: t[`${state.cameraError}Hint`], action: 'retry' }
    if (state.starting) return { kind: 'starting', title: t.starting }
    if (state.paused) return { kind: 'paused', title: t.paused, hint: t.pausedHint, action: 'resume' }
    return null
  }
  if (state.ended) return { kind: 'ended', title: t.ended, hint: fill(t.endedHint, { code: spaced(state.code) }), action: 'home' }
  if (state.offline) return { kind: 'offline', title: t.offline, hint: t.offlineHint }
  if (state.paused) return { kind: 'paused', title: t.viewerPaused, hint: t.viewerPausedHint }
  if (!state.live) return { kind: 'waiting', title: t.waitingTitle, hint: t.waitingHint }
  return null
}

// The age of the link is the one number a viewer needs: rotating QR codes expire.
function tickAge() {
  if (!state.link) return
  const seconds = Math.max(0, Math.floor((Date.now() - state.link.scannedAt) / 1000))
  const clock = seconds >= 3600 ? '59:59+' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  $('link-age').textContent = clock
  $('link-age').dateTime = `PT${seconds}S`
  $('link-age').title = fill(t.scannedAgo, { t: clock })
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
  toast(t.copied)
}

// ---------- Home: typing a code ----------

function press(digit) {
  if (state.view !== 'home' || state.entry === 'checking' || state.entry === 'locked') return
  if (state.entry === 'error') Object.assign(state, { entry: 'idle', digits: '' })
  if (state.digits.length >= 6) return
  typed = state.digits.length
  state.digits += digit
  render()
  if (state.digits.length === 6) void join(state.digits)
}

function erase(all = false) {
  if (state.entry !== 'idle' && state.entry !== 'error') return
  state.digits = all || state.entry === 'error' ? '' : state.digits.slice(0, -1)
  state.entry = 'idle'
  render()
}

async function join(code) {
  Object.assign(state, { entry: 'checking', digits: code })
  render()
  const next = (await joinRoom(code)) ?? (demo ? await demoRoom(code) : null)
  if (state.view !== 'home' || state.digits !== code) return next?.leave()
  if (!next) {
    state.entry = 'error'
    memory.set(null)
    render()
    buzz([30, 40, 30])
    return
  }
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
  else {
    player = framePlayer()
    show(player.stream)
  }
  room.addEventListener('state', (event) => {
    const before = state.viewers
    Object.assign(state, pick(event.detail))
    if (state.viewers > before) flash($('presence'), 'bump', 400)
    render()
  })
  room.addEventListener('link', (event) => receive(event.detail, true))
  room.addEventListener('frame', (event) => void player?.draw(event.detail).catch(() => {}))
  room.addEventListener('ended', () => {
    state.ended = true
    memory.set(null)
    render()
  })
  room.start()
  memory.set({ code: next.code, role: 'viewer' })
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
  if (document.hidden) document.title = `● ${t.newLink} · ${title}`
}

// ---------- Camera ----------

function enterCamera(code) {
  room = hostRoom(code)
  Object.assign(state, fresh(), { view: 'room', role: 'camera', code: room.code, invite: !code })
  memory.set({ code: room.code, role: 'camera' })
  room.addEventListener('viewers', (event) => setViewers(event.detail, state.extra))
  if (demo) stops.push(crowd((n) => setViewers(state.viewers, n)))
  $('invite-code').textContent = spaced(room.code)
  render()
  rest()
  void startCamera()
}

function setViewers(real, extra) {
  const before = state.viewers + state.extra
  Object.assign(state, { viewers: real, extra })
  if (real + extra > before) {
    flash($('presence'), 'bump', 400)
    toast(t.joined)
  }
  render()
}

async function startCamera() {
  Object.assign(state, { starting: true, cameraError: '' })
  render()
  let opened
  try {
    opened = await openCamera({ demo })
  } catch (e) {
    Object.assign(state, { starting: false, cameraError: e.kind ?? 'blocked' })
    return render()
  }
  if (state.role !== 'camera') return opened.stop()
  camera = opened
  show(camera.stream)
  $('zoom').replaceChildren(...camera.zooms.map((zoom) => {
    const button = Object.assign(document.createElement('button'), { textContent: `${zoom}×` })
    button.dataset.zoom = zoom
    return button
  }))
  Object.assign(state, { starting: false, live: true, paused: false, zoom: 1, torch: false })
  room.setState({ live: true, paused: false })
  stops.push(
    scan(video, seen),
    relay(video, (frame) => { if (!state.paused) room.sendFrame(frame) }),
  )
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
  if (state.role !== 'camera' || document.hidden) return
  try { wakeLock = await navigator.wakeLock?.request('screen') } catch { /* The screen may sleep. */ }
}

function arm() {
  if (state.armed) return exit(true)
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
  if (locale === 'tr') url.searchParams.set('lang', 'tr')
  if (demo) url.searchParams.set('demo', '')
  return url.href
}


function openInvite() {
  $('invite-code').textContent = spaced(state.code)
  state.invite = true
  render()
  $('invite-done').focus()
}

function exit(ending = false) {
  if (ending) room?.end()
  else room?.leave?.()
  stops.forEach((stop) => stop())
  camera?.stop()
  void wakeLock?.release().catch(() => {})
  video.srcObject = null
  room = camera = player = wakeLock = null
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
$('new-room').addEventListener('click', () => enterCamera())
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
$('link-copy').addEventListener('click', () => state.link && copyText(state.link.url))
$('invite-copy').addEventListener('click', () => copyText(inviteUrl()))
$('invite-share').addEventListener('click', async () => {
  const data = { title, text: fill(t.shareText, { code: spaced(state.code) }), url: inviteUrl() }
  if (navigator.canShare?.(data)) return navigator.share(data).catch(() => {})
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
  if (state.view !== 'home' || !match || state.entry === 'checking') return
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
window.addEventListener('pagehide', () => {
  if (state.role === 'viewer') room?.leave()
})
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })

// ---------- Start: restore a room, follow an invite link, or show the keypad ----------

const saved = memory.get()
const invited = (params.get('room') ?? '').replace(/\D/g, '')
if (params.has('room')) {
  params.delete('room')
  const query = params.toString().replace(/(^|&)demo=(?=&|$)/, '$1demo')
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`)
}
if (saved?.role === 'camera' && /^\d{6}$/.test(saved.code)) enterCamera(saved.code)
else if (saved?.role === 'viewer' && /^\d{6}$/.test(saved.code)) void join(saved.code)
else if (invited.length === 6) void join(invited)
else render()
