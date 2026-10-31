import { copy } from './copy.js'
import { gatherICE, isSharingPhone, safeQRLink } from './rtc.js'

const locale = new URLSearchParams(location.search).get('lang') === 'tr' ? 'tr' : 'en'
const t = copy[locale]
const API = window.ATTENDLESS_CONFIG?.apiUrl || ''
const $ = (id) => document.getElementById(id)
const video = $('video')
let code = '', token = '', busy = false, sharing = false, active = false
let connected = false, error = '', link = '', scannedAt = 0
const phone = isSharingPhone(navigator)
let stream = null, epoch = '', isSharing = false, revision = 0, incomingScan = 0
let latestQR = { url: '', scannedAt: 0 }, starting = false, alive = true
const answeredOffers = new Map(), peers = new Map(), channels = new Set()
let polling = null, sessionRevision = 0
class APIError extends Error {
  constructor(status) { super(`API ${status}`); this.status = status }
}
const setBusy = (value) => { busy = value; render() }
const setSharing = (value) => { sharing = value; render() }
const setActive = (value) => { active = value; render() }
const setConnected = (value) => { connected = value; render() }
const setError = (value) => { error = value; render() }
const setLink = (value) => { link = value; render() }
const setScannedAt = (value) => { scannedAt = value; render() }
function setToken(value) {
  token = value
  sessionRevision++
  clearInterval(polling)
  polling = null
  if (token) pollRoom()
  render()
}

for (const element of document.querySelectorAll('[data-copy]')) element.textContent = t[element.dataset.copy]
document.documentElement.lang = locale
document.title = `${t.title} — ${locale === 'tr' ? 'Yoklama QR' : 'Attendance QR'}`
$('language').href = locale === 'tr' ? '?lang=en' : '?lang=tr'
$('language').textContent = locale === 'tr' ? 'English' : 'Türkçe'
$('language').hreflang = locale === 'tr' ? 'en' : 'tr'

function render() {
  $('join-form').hidden = Boolean(token)
  $('room').hidden = !token
  $('unavailable').hidden = Boolean(API)
  $('join').disabled = busy || code.length !== 6 || !API
  $('join').textContent = busy ? t.joining : t.join
  $('status').textContent = sharing || connected ? `● ${t.live}` : active ? t.connecting : t.waiting
  video.hidden = !active
  $('share').hidden = !phone || sharing
  $('share').disabled = active || busy
  $('share').textContent = busy ? t.starting : t.share
  $('stop').hidden = !sharing
  $('leave').disabled = busy
  $('device-hint').textContent = phone ? t.aim : t.phone
  $('error').textContent = error
  $('error').hidden = !error
  // Only update the live region when its content changes.
  const scanKey = `${link}:${scannedAt}`
  if ($('qr-result').dataset.scan !== scanKey) {
    $('qr-result').dataset.scan = scanKey
    $('no-qr').hidden = Boolean(link)
    $('scan').hidden = !link
    if (link) {
      $('qr-link').href = link
      $('qr-url').textContent = link
      $('scanned-at').textContent = `${t.scannedAt} ${new Date(scannedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    } else {
      $('qr-link').removeAttribute('href')
      $('qr-url').textContent = ''
      $('scanned-at').textContent = ''
    }
  }
}

async function call(
  action,
  data = {},
  auth = token,
) {
  if (!API) throw new Error(t.unavailable)
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({ action, ...data }),
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  })
  if (!res.ok) throw new APIError(res.status)
  return res.json()
}
function clearMedia() {
  revision++
  peers.forEach((pc) => pc.close())
  peers.clear()
  answeredOffers.clear()
  channels.forEach((ch) => ch.close())
  channels.clear()
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  if (video) video.srcObject = null
  isSharing = false
  epoch = ''
  incomingScan = 0
  if (alive) {
    setSharing(false)
    setConnected(false)
  }
}
function release(keepalive = false) {
  if (API && token && isSharing)
    void fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: 'release', epoch }),
      keepalive,
    }).catch(() => {})
  clearMedia()
}
function newPeer() {
  const rev = revision
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
  ]
  const pc = new RTCPeerConnection({ iceServers })
  pc.onconnectionstatechange = () => {
    if (rev !== revision || !alive) return
    if (
      isSharing &&
      ['failed', 'closed'].includes(pc.connectionState)
    ) {
      for (const [id, current] of peers)
        if (current === pc) peers.delete(id)
      return
    }
    if (!alive) return
    if (pc.connectionState === 'failed') {
      setError(t.network)
      if (!isSharing) {
        clearMedia()
      }
    }
    if (
      !isSharing &&
      ['disconnected', 'closed'].includes(pc.connectionState)
    ) {
      setConnected(false)
    }
    if (!isSharing && pc.connectionState === 'connected') {
      setConnected(true)
      setError('')
    }
  }
  return pc
}
function receiveChannel(ch) {
  const rev = revision
  ch.onmessage = (event) => {
    if (rev !== revision || !alive) return
    try {
      const data = JSON.parse(event.data)
      const url = safeQRLink(data.url)
      if (
        url &&
        Number.isFinite(data.scannedAt) &&
        data.scannedAt > incomingScan
      ) {
        incomingScan = data.scannedAt
        setLink(url)
        setScannedAt(data.scannedAt)
      }
    } catch {
      /* Ignore invalid peer messages. */
    }
  }
  channels.add(ch)
}
async function watch(roomEpoch) {
  if (starting) return
  clearMedia()
  epoch = roomEpoch
  const rev = revision
  const pc = newPeer()
  peers.set('sharer', pc)
  const ch = pc.createDataChannel('qr', { ordered: false, maxRetransmits: 0 })
  receiveChannel(ch)
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.ontrack = (event) => {
    if (revision !== rev) return
    if (video) {
      video.srcObject =
        event.streams[0] ?? new MediaStream([event.track])
      void video.play().catch(() => {})
    }
  }
  try {
    await pc.setLocalDescription(await pc.createOffer())
    await gatherICE(pc)
    if (revision !== rev) return
    await call('offer', { epoch: roomEpoch, sdp: pc.localDescription.sdp })
  } catch (e) {
    if (revision === rev) {
      clearMedia()
      setError(e instanceof APIError ? t.error : t.network)
    }
  }
}
async function answer(peer, roomEpoch) {
  const existing = peers.get(peer.peer)
  if (!existing && answeredOffers.get(peer.peer) === peer.offer) return
  if (
    existing &&
    (existing.remoteDescription?.sdp === peer.offer ||
      !existing.remoteDescription)
  )
    return
  if (existing) {
    existing.close()
    peers.delete(peer.peer)
  }
  if (!stream) return
  const rev = revision
  const pc = newPeer()
  peers.set(peer.peer, pc)
  pc.ondatachannel = (event) => {
    const ch = event.channel
    if (revision !== rev) { ch.close(); return }
    channels.add(ch)
    ch.onopen = () => {
      if (latestQR.url) ch.send(JSON.stringify(latestQR))
    }
    ch.onclose = () => channels.delete(ch)
  }
  try {
    for (const track of stream.getVideoTracks()) {
      const sender = pc.addTrack(track, stream)
      const params = sender.getParameters()
      params.encodings = (params.encodings?.length ? params.encodings : [{}]).map(
        (encoding) => ({ ...encoding, maxFramerate: 30, maxBitrate: 1000000 }),
      )
      params.degradationPreference = 'maintain-resolution'
      await sender.setParameters(params)
    }
    await pc.setRemoteDescription({ type: 'offer', sdp: peer.offer })
    await pc.setLocalDescription(await pc.createAnswer())
    await gatherICE(pc)
    if (revision !== rev) return
    await call('answer', {
      epoch: roomEpoch,
      peer: peer.peer,
      offer: peer.offer,
      sdp: pc.localDescription.sdp,
    })
    if (revision === rev) answeredOffers.set(peer.peer, peer.offer)
  } catch {
    pc.close()
    if (peers.get(peer.peer) === pc) peers.delete(peer.peer)
  }
}
async function start() {
  const auth = token
  let startRevision = revision
  starting = true
  setBusy(true)
  setError('')
  let claimed = ''
  try {
    const camera = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    })
    if (!alive || document.hidden || revision !== startRevision) {
      camera.getTracks().forEach((track) => track.stop())
      return
    }
    const track = camera.getVideoTracks()[0],
      settings = track.getSettings()
    if (
      Math.min(settings.width ?? 0, settings.height ?? 0) < 720 ||
      Math.max(settings.width ?? 0, settings.height ?? 0) < 1280
    ) {
      camera.getTracks().forEach((track) => track.stop())
      throw new Error(t.camera)
    }
    clearMedia()
    startRevision = revision
    latestQR = { url: '', scannedAt: 0 }
    stream = camera
    const result = await call('claim', {}, auth)
    claimed = result.epoch
    if (!alive || document.hidden || revision !== startRevision) {
      await call('release', { epoch: claimed }, auth)
      camera.getTracks().forEach((track) => track.stop())
      return
    }
    epoch = claimed
    isSharing = true
    setSharing(true)
    setActive(true)
    track.onended = () => release()
    if (video) {
      video.srcObject = camera
      await video.play()
    }
  } catch (e) {
    if (claimed) void call('release', { epoch: claimed }, auth).catch(() => {})
    clearMedia()
    setError(e instanceof APIError && e.status === 409 ? t.busy : t.camera)
  } finally {
    starting = false
    setBusy(false)
  }
}

function pollRoom() {
  const session = sessionRevision
  let running = false, failures = 0
  const stopped = () => session !== sessionRevision || !alive
  async function tick() {
    if (stopped() || running || starting) return
    running = true
    try {
      const state = await call('status')
      if (stopped() || starting) return
      setActive(state.active)
      if (isSharing) {
        if (!state.sharing || state.epoch !== epoch) { clearMedia(); return }
        await call('heartbeat', { epoch })
        if (stopped()) return
        const list = await call('peers', { epoch })
        if (stopped()) return
        // Answers gather ICE independently so they cannot delay lease renewal.
        void Promise.all(list.peers.map((peer) => answer(peer, epoch)))
      } else if (!state.active) {
        if (epoch) clearMedia()
      } else if (epoch !== state.epoch) {
        await watch(state.epoch)
      } else {
        const pc = peers.get('sharer')
        if (pc && !pc.remoteDescription) {
          const result = await call('connection', { epoch })
          if (!stopped() && peers.get('sharer') === pc && result.answer)
            await pc.setRemoteDescription({ type: 'answer', sdp: result.answer })
        }
      }
      failures = 0
    } catch (e) {
      if (stopped()) return
      if (e instanceof APIError && e.status === 401) {
        release(); setToken(''); setActive(false); setError(t.expired)
      } else if (e instanceof APIError && e.status === 409) {
        clearMedia()
      } else if (++failures >= 2) {
        release(); setError(t.error)
      }
    } finally { running = false }
  }
  polling = setInterval(() => void tick(), 2000)
  void tick()
}

const canvas = document.createElement('canvas')
const context = canvas.getContext('2d', { willReadFrequently: true })
let lastTime = -1
const scanner = setInterval(() => {
  if (!isSharing || !context || video.readyState < 2 || video.currentTime === lastTime) return
  lastTime = video.currentTime
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  context.drawImage(video, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const qr = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' })
  const url = safeQRLink(qr?.data)
  if (url && url !== latestQR.url) {
    latestQR = { url, scannedAt: Date.now() }
    setLink(url); setScannedAt(latestQR.scannedAt)
  }
  // Repeat the last scan; losing an unordered packet must not lose the QR link.
  if (latestQR.url)
    for (const ch of channels)
      if (ch.readyState === 'open' && ch.bufferedAmount < 4096)
        ch.send(JSON.stringify(latestQR))
}, 100)

$('room-code').addEventListener('input', (event) => {
  code = event.target.value.replace(/\D/g, '').slice(0, 6)
  event.target.value = code
  render()
})
$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (busy || code.length !== 6 || !API) return
  setBusy(true); setError('')
  try {
    const result = await call('join', { code }, '')
    if (!alive) return
    setLink(''); setScannedAt(0); setToken(result.token)
  } catch (e) {
    setError(e instanceof APIError && e.status === 401 ? t.incorrect : t.error)
  } finally { setBusy(false) }
})
$('share').addEventListener('click', () => { if (phone && !active && !busy) void start() })
$('stop').addEventListener('click', () => release())
$('leave').addEventListener('click', () => {
  release(); setToken(''); setActive(false); setLink(''); setScannedAt(0); setError('')
  $('room-code').focus()
})
window.addEventListener('pagehide', () => {
  alive = false
  release(true)
  clearInterval(polling)
  clearInterval(scanner)
  sessionRevision++
})
// Reload a page restored from the back-forward cache with a fresh room lifecycle.
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload() })
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (isSharing || starting)) release(true)
})
render()
