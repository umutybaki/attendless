import { gatherICE, safeQRLink } from './rtc.js'
import { relay, framePlayer } from './camera.js'

// Two transports behind one interface. With an API configured (config.js),
// rooms live on the backend and video and links travel peer to peer over
// WebRTC. Without one, rooms travel over a BroadcastChannel between tabs of
// this browser, which is enough to develop and test the UI.
//
//   await hostRoom(saved?)       -> { code, token, publish(stream, video), setState({ paused }),
//                                     sendLink(link), end(), leave() }; events: 'viewers', 'ended'
//   await joinRoom(code, token?) -> null for an unknown code, or { code, token, welcomed: { state, link },
//                                     stream, start(), leave() }; events: 'state', 'link', 'stream', 'ended'
//                                   Throws when the API cannot be reached.
const api = window.ATTENDLESS_CONFIG?.apiUrl || ''
const pollEvery = 2000

export const hostRoom = (saved) => (api ? ApiHost.open(saved) : LocalHost.open(saved))
export const joinRoom = (code, token) => (api ? ApiViewer.open(code, token) : LocalViewer.open(code))

class Room extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }
}

// ---------- API transport ----------

class APIError extends Error {
  constructor(status) {
    super(`API ${status}`)
    this.status = status
  }
}
const gone = (e) => e instanceof APIError && [401, 404, 410].includes(e.status)
const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]

async function call(action, data = {}, token = '', keepalive = false) {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...data }),
    signal: keepalive ? undefined : AbortSignal.timeout(12000),
    cache: 'no-store',
    keepalive,
  })
  if (!response.ok) throw new APIError(response.status)
  return response.json()
}

// The camera: holds the sharing lease and answers each viewer's offer.
class ApiHost extends Room {
  static async open(saved) {
    const { code, token } = saved?.token ? saved : await call('create')
    const room = new ApiHost(code, token)
    room.timers = [
      setInterval(() => void room.tick(), pollEvery),
      // Links go over an unordered, lossy channel, so the latest one repeats.
      setInterval(() => room.sendLink(room.link), 500),
    ]
    void room.tick()
    return room
  }
  constructor(code, token) {
    super()
    Object.assign(this, { code, token, epoch: '', paused: false, link: null, stream: null, viewers: 0 })
    this.peers = new Map()
    this.answered = new Map()
    this.channels = new Set()
  }
  publish(stream) {
    this.stream = stream
    void this.claim()
  }
  async claim() {
    try {
      const { epoch } = await call('claim', {}, this.token)
      this.hangUp()
      this.epoch = epoch
    } catch (e) {
      this.fail(e)
    }
  }
  setState({ paused }) {
    this.paused = Boolean(paused)
    void this.tick()
  }
  async tick() {
    if (this.running || this.closed) return
    this.running = true
    try {
      if (this.epoch) {
        this.count((await call('heartbeat', { epoch: this.epoch, paused: this.paused }, this.token)).viewers)
        const { peers } = await call('peers', { epoch: this.epoch }, this.token)
        // Answers gather ICE independently so they cannot delay lease renewal.
        for (const peer of peers) void this.answer(peer)
      } else this.count((await call('status', {}, this.token)).viewers)
    } catch (e) {
      this.fail(e)
    } finally {
      this.running = false
    }
  }
  fail(e) {
    if (this.closed) return
    if (gone(e)) {
      this.close()
      this.emit('ended')
    } else if (e instanceof APIError && e.status === 409 && this.stream) {
      // The lease lapsed while the page was throttled or asleep: take it back.
      this.epoch = ''
      void this.claim()
    }
  }
  count(viewers) {
    if (viewers === this.viewers) return
    this.viewers = viewers
    this.emit('viewers', viewers)
  }
  async answer({ peer, offer }) {
    const existing = this.peers.get(peer)
    if (!existing && this.answered.get(peer) === offer) return
    if (existing && (existing.remoteDescription?.sdp === offer || !existing.remoteDescription)) return
    existing?.close()
    this.peers.delete(peer)
    if (!this.stream) return
    const epoch = this.epoch, pc = new RTCPeerConnection({ iceServers })
    this.peers.set(peer, pc)
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState) && this.peers.get(peer) === pc) this.peers.delete(peer)
    }
    pc.ondatachannel = ({ channel }) => {
      this.channels.add(channel)
      channel.onopen = () => this.send(channel, this.link)
      channel.onclose = () => this.channels.delete(channel)
    }
    try {
      for (const track of this.stream.getVideoTracks()) {
        const sender = pc.addTrack(track, this.stream)
        const params = sender.getParameters()
        params.encodings = (params.encodings?.length ? params.encodings : [{}]).map((encoding) => ({ ...encoding, maxFramerate: 30, maxBitrate: 1000000 }))
        params.degradationPreference = 'maintain-resolution'
        await sender.setParameters(params)
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: offer })
      await pc.setLocalDescription(await pc.createAnswer())
      await gatherICE(pc)
      if (epoch !== this.epoch || this.closed) return pc.close()
      await call('answer', { epoch, peer, offer, sdp: pc.localDescription.sdp }, this.token)
      this.answered.set(peer, offer)
    } catch {
      pc.close()
      if (this.peers.get(peer) === pc) this.peers.delete(peer)
    }
  }
  sendLink(link) {
    this.link = link
    for (const channel of this.channels) this.send(channel, link)
  }
  send(channel, link) {
    if (link && channel.readyState === 'open' && channel.bufferedAmount < 4096) channel.send(JSON.stringify(link))
  }
  hangUp() {
    this.peers.forEach((pc) => pc.close())
    this.channels.forEach((channel) => channel.close())
    this.peers.clear()
    this.answered.clear()
    this.channels.clear()
  }
  close() {
    this.closed = true
    this.timers?.forEach(clearInterval)
    this.hangUp()
  }
  // Leaving the page frees the camera slot at once instead of after the lease lapses.
  leave() {
    if (this.epoch && !this.closed) void call('release', { epoch: this.epoch }, this.token, true).catch(() => {})
    this.close()
  }
  end() {
    if (!this.closed) void call('end', {}, this.token, true).catch(() => {})
    this.close()
  }
}

class ApiViewer extends Room {
  static async open(code, token) {
    try {
      token ||= (await call('join', { code })).token
      const room = new ApiViewer(code, token)
      room.welcomed = { state: await call('status', {}, token), link: null }
      return room
    } catch (e) {
      if (gone(e)) return null
      throw e
    }
  }
  constructor(code, token) {
    super()
    Object.assign(this, { code, token, epoch: '', pc: null, stream: null, scannedAt: 0, failures: 0 })
  }
  start() {
    this.timer = setInterval(() => void this.tick(), pollEvery)
    void this.adopt(this.welcomed.state).catch(() => {})
  }
  async tick() {
    if (this.running || this.closed) return
    this.running = true
    try {
      const state = await call('status', {}, this.token)
      this.failures = 0
      this.emit('state', state)
      await this.adopt(state)
    } catch (e) {
      if (gone(e)) {
        this.close()
        this.emit('ended')
      } else if (++this.failures >= 2) this.emit('state', { ...this.last, live: false, offline: true })
    } finally {
      this.running = false
    }
  }
  async adopt(state) {
    this.last = state
    if (!state.live) return this.hangUp()
    if (state.epoch !== this.epoch) return this.watch(state.epoch)
    const pc = this.pc
    if (pc && !pc.remoteDescription) {
      const { answer } = await call('connection', { epoch: this.epoch }, this.token)
      if (answer && this.pc === pc) await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    }
  }
  async watch(epoch) {
    this.hangUp()
    this.epoch = epoch
    const pc = (this.pc = new RTCPeerConnection({ iceServers }))
    const channel = pc.createDataChannel('qr', { ordered: false, maxRetransmits: 0 })
    channel.onmessage = (event) => this.receive(event.data)
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.ontrack = (event) => {
      if (this.pc !== pc) return
      this.stream = event.streams[0] ?? new MediaStream([event.track])
      this.emit('stream', this.stream)
    }
    // A failed connection is dropped; the next poll offers again.
    pc.onconnectionstatechange = () => { if (this.pc === pc && pc.connectionState === 'failed') this.hangUp() }
    try {
      await pc.setLocalDescription(await pc.createOffer())
      await gatherICE(pc)
      if (this.pc === pc) await call('offer', { epoch, sdp: pc.localDescription.sdp }, this.token)
    } catch {
      if (this.pc === pc) this.hangUp()
    }
  }
  receive(data) {
    try {
      const link = JSON.parse(data)
      if (!safeQRLink(link.url) || !Number.isFinite(link.scannedAt) || link.scannedAt <= this.scannedAt) return
      this.scannedAt = link.scannedAt
      this.emit('link', link)
    } catch { /* Ignore invalid peer messages. */ }
  }
  hangUp() {
    this.pc?.close()
    this.pc = null
    this.epoch = ''
  }
  close() {
    this.closed = true
    clearInterval(this.timer)
    this.hangUp()
  }
  leave() {
    this.close()
  }
}

// ---------- Same-browser transport ----------

const channelName = 'attendless-rooms'
const answerWithin = 800, staleAfter = 6500
const randomId = () => crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`
const newCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0')

class LocalRoom extends Room {
  constructor(code) {
    super()
    this.code = code
    this.id = randomId()
    this.channel = new BroadcastChannel(channelName)
    this.channel.onmessage = (event) => {
      if (event.data?.code === code && event.data.from !== this.id) this.receive(event.data)
    }
  }
  post(type, data = {}) {
    if (!this.closed) this.channel.postMessage({ type, code: this.code, from: this.id, ...data })
  }
  close() {
    clearInterval(this.timer)
    this.closed = true
    this.channel.close()
  }
}

// The camera's side: answers knocks, counts viewers, fans out state, links and frames.
class LocalHost extends LocalRoom {
  static open(saved) {
    return new LocalHost(saved?.code ?? newCode())
  }
  constructor(code) {
    super(code)
    this.viewers = new Map()
    this.state = { live: false, paused: false }
    this.link = null
    this.timer = setInterval(() => this.prune(), pollEvery)
  }
  receive(message) {
    if (message.type === 'knock') this.post('welcome', { to: message.from, state: this.snapshot(), link: this.link })
    if (message.type === 'knock' || message.type === 'ping') this.see(message.from)
    if (message.type === 'bye' && this.viewers.delete(message.from)) this.changed()
  }
  see(id) {
    const known = this.viewers.has(id)
    this.viewers.set(id, Date.now())
    if (!known) this.changed()
  }
  prune() {
    let gone = false
    for (const [id, seen] of this.viewers) if (Date.now() - seen > staleAfter) gone = this.viewers.delete(id) || gone
    if (gone) this.changed()
    else this.post('state', { state: this.snapshot() })
  }
  changed() {
    this.post('state', { state: this.snapshot() })
    this.emit('viewers', this.viewers.size)
  }
  snapshot() {
    return { ...this.state, viewers: this.viewers.size }
  }
  publish(stream, video) {
    this.stopRelay?.()
    this.stopRelay = relay(video, (frame) => { if (!this.state.paused && this.viewers.size) this.post('frame', { frame }) })
    this.setState({ live: true, paused: false })
  }
  setState({ paused }) {
    Object.assign(this.state, { live: !paused, paused: Boolean(paused) })
    this.post('state', { state: this.snapshot() })
  }
  sendLink(link) {
    this.link = link
    this.post('link', { link })
  }
  close() {
    this.stopRelay?.()
    super.close()
  }
  leave() {
    this.close()
  }
  end() {
    this.post('ended')
    this.close()
  }
}

class LocalViewer extends LocalRoom {
  static async open(code) {
    const room = new LocalViewer(code)
    if (await room.knock()) return room
    room.close()
    return null
  }
  constructor(code) {
    super(code)
    this.player = framePlayer()
    this.stream = this.player.stream
  }
  receive(message) {
    if (message.type === 'welcome' && message.to === this.id) this.welcome?.(message)
    if (message.type === 'state') {
      this.seen = Date.now()
      this.last = message.state
      this.emit('state', message.state)
    }
    if (message.type === 'link') this.emit('link', message.link)
    if (message.type === 'frame') void this.player.draw(message.frame).catch(() => {})
    if (message.type === 'ended') {
      this.close()
      this.emit('ended')
    }
  }
  knock() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), answerWithin)
      this.welcome = (message) => {
        clearTimeout(timeout)
        this.welcomed = message
        this.last = message.state
        this.seen = Date.now()
        resolve(true)
      }
      this.post('knock')
    })
  }
  start() {
    this.timer = setInterval(() => {
      this.post('ping')
      if (Date.now() - this.seen > staleAfter) this.emit('state', { ...this.last, live: false, offline: true })
    }, pollEvery)
  }
  leave() {
    this.post('bye')
    this.close()
  }
}
