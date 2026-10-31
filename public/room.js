import { gatherICE, safeQRLink } from './rtc.js'
import { relay, framePlayer } from './camera.js'

// Two transports behind one interface. With an API configured (config.js),
// rooms live in a Cloudflare Durable Object reached over one WebSocket per
// page, and video and links travel peer to peer over WebRTC. Without one,
// rooms travel over a BroadcastChannel between tabs of this browser, which is
// enough to develop and test the UI.
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

// The camera's stream to each viewer. Viewers only need to see the scene: the
// link arrives separately and the camera reads codes from its full-resolution
// capture, so the stream stays small. Bandwidth adaptation lowers the frame
// rate before the resolution.
const VIDEO = { maxBitrate: 400_000, maxFramerate: 15 }
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }]
const epochId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

class APIError extends Error {
  constructor(status) {
    super(`API ${status}`)
    this.status = status
  }
}
const gone = (e) => e instanceof APIError && [401, 404, 410].includes(e.status)
const endpoint = (path) => new URL(path, new URL(api.endsWith('/') ? api : `${api}/`, location.href))

async function post(path) {
  const response = await fetch(endpoint(path), { method: 'POST', signal: AbortSignal.timeout(12000), cache: 'no-store' })
  if (!response.ok) throw new APIError(response.status)
  return response.json()
}

// One WebSocket to the room that says hello with the token, reconnects with
// backoff, and pings so a dead connection is noticed. The server answers
// pings without waking the room, so they cost nothing.
class Line {
  constructor(code, token, handlers) {
    Object.assign(this, { code, token, handlers, ws: null, ready: false, closed: false, attempt: 0 })
    this.wake = () => { if (!document.hidden && !this.ws && !this.closed) this.connect() }
    document.addEventListener('visibilitychange', this.wake)
    window.addEventListener('online', this.wake)
    this.connect()
  }
  connect() {
    clearTimeout(this.retry)
    const url = endpoint(`rooms/${this.code}/socket`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = (this.ws = new WebSocket(url))
    let answered = true
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', token: this.token }))
      this.pinger = setInterval(() => {
        // No pong since the last ping: the connection is dead even if the browser hasn't noticed.
        if (!answered) return ws.close(4000, 'No pong')
        answered = false
        ws.send('ping')
      }, 25000)
    }
    ws.onmessage = ({ data }) => {
      answered = true
      if (data === 'pong') return
      let message
      try { message = JSON.parse(data) } catch { return }
      if (message.type === 'welcome') {
        this.ready = true
        this.attempt = 0
      }
      this.handlers.message(message)
    }
    ws.onclose = ({ code }) => {
      clearInterval(this.pinger)
      if (this.ws !== ws) return
      this.ws = null
      this.ready = false
      if (this.closed) return
      if (code === 4410 || code === 4409 || code === 4400) {
        this.close()
        return this.handlers.gone()
      }
      this.handlers.down?.()
      const delay = Math.min(15000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() / 2)
      this.retry = setTimeout(() => this.connect(), document.hidden ? Math.max(delay, 5000) : delay)
    }
  }
  send(message) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }
  close() {
    this.closed = true
    clearTimeout(this.retry)
    document.removeEventListener('visibilitychange', this.wake)
    window.removeEventListener('online', this.wake)
    const ws = this.ws
    this.ws = null
    // Messages sent just before are delivered ahead of the close.
    if (ws?.readyState === WebSocket.OPEN) ws.close(1000)
    else if (ws) ws.onopen = () => ws.close(1000)
  }
}

// The camera: announces its stream and answers each viewer's offer.
class ApiHost extends Room {
  static async open(saved) {
    const { code, token } = saved?.token ? saved : await post('rooms')
    return new ApiHost(code, token)
  }
  constructor(code, token) {
    super()
    Object.assign(this, { code, token, epoch: '', paused: false, link: null, stream: null, viewers: 0, iceServers: STUN })
    this.peers = new Map()
    this.channels = new Set()
    this.line = new Line(code, token, {
      message: (message) => this.receive(message),
      gone: () => { this.close(); this.emit('ended') },
    })
    // Links go over an unordered, lossy channel, so the latest one repeats.
    this.timer = setInterval(() => this.sendLink(this.link), 500)
  }
  receive(message) {
    if (message.type === 'welcome') {
      this.iceServers = message.iceServers?.length ? message.iceServers : STUN
      this.count(message.state.viewers)
      // After a reconnect, restore what the room should show.
      if (this.epoch) this.announce()
    } else if (message.type === 'state') this.count(message.state.viewers)
    else if (message.type === 'offer') void this.answer(message)
    else if (message.type === 'gone') this.drop(message.peer)
  }
  // A new stream is a new generation: viewers connect to it afresh.
  publish(stream) {
    this.stream = stream
    this.hangUp()
    this.epoch = epochId()
    this.announce()
  }
  setState({ paused }) {
    this.paused = Boolean(paused)
    this.announce()
  }
  announce() {
    this.line.send({ type: 'live', epoch: this.epoch, paused: this.paused })
  }
  count(viewers) {
    if (viewers === this.viewers) return
    this.viewers = viewers
    this.emit('viewers', viewers)
  }
  drop(peer) {
    this.peers.get(peer)?.close()
    this.peers.delete(peer)
  }
  async answer({ peer, sdp: offer }) {
    // A repeated offer from the same viewer replaces its connection.
    this.drop(peer)
    if (!this.stream || typeof offer !== 'string') return
    const epoch = this.epoch, pc = new RTCPeerConnection({ iceServers: this.iceServers })
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
        params.encodings = (params.encodings?.length ? params.encodings : [{}]).map((encoding) => ({ ...encoding, ...VIDEO }))
        params.degradationPreference = 'maintain-resolution'
        await sender.setParameters(params)
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: offer })
      await pc.setLocalDescription(await pc.createAnswer())
      await gatherICE(pc)
      if (epoch !== this.epoch || this.closed || this.peers.get(peer) !== pc) return pc.close()
      this.line.send({ type: 'answer', peer, epoch, sdp: pc.localDescription.sdp })
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
    this.channels.clear()
  }
  close() {
    this.closed = true
    clearInterval(this.timer)
    this.line.close()
    this.hangUp()
  }
  // Leaving the page takes the camera off the air at once; the room stays for a reload.
  leave() {
    if (this.closed) return
    this.line.send({ type: 'live', epoch: '', paused: false })
    this.close()
  }
  end() {
    if (this.closed) return
    this.line.send({ type: 'end' })
    this.close()
  }
}

class ApiViewer extends Room {
  static async open(code, token) {
    try {
      token ||= (await post(`rooms/${code}/join`)).token
    } catch (e) {
      if (gone(e)) return null
      throw e
    }
    const room = new ApiViewer(code, token)
    const state = await room.welcome
    if (!state) return null
    room.welcomed = { state, link: null }
    return room
  }
  constructor(code, token) {
    super()
    Object.assign(this, { code, token, epoch: '', pc: null, stream: null, scannedAt: 0, last: null, started: false, iceServers: STUN })
    // Settles with the first welcome (the room's state), null if the room is gone,
    // or an error if the room can't be reached at all.
    this.welcome = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.close(); reject(new Error('Unreachable')) }, 12000)
      this.settle = (value, error) => { clearTimeout(timeout); this.settle = null; error ? reject(error) : resolve(value) }
    })
    this.line = new Line(code, token, {
      message: (message) => this.message(message),
      gone: () => {
        if (this.settle) return this.settle(null)
        this.close()
        this.emit('ended')
      },
      down: () => {
        if (this.settle) { this.close(); return this.settle(null, new Error('Unreachable')) }
        clearTimeout(this.offline)
        // A short blip is not worth a warning; the video keeps flowing peer to peer.
        this.offline = setTimeout(() => { if (!this.line.ready) this.emit('state', { ...this.last, live: false, offline: true }) }, 4000)
      },
    })
  }
  message(message) {
    if (message.type === 'welcome') {
      this.iceServers = message.iceServers?.length ? message.iceServers : STUN
      clearTimeout(this.offline)
      if (this.settle) return this.settle(message.state)
      this.update(message.state)
    } else if (message.type === 'state') this.update(message.state)
    else if (message.type === 'answer') void this.answered(message)
    else if (message.type === 'ended') {
      this.close()
      this.emit('ended')
    }
  }
  start() {
    this.started = true
    this.update(this.last ?? this.welcomed.state)
  }
  update(state) {
    this.last = state
    if (!this.started) return
    this.emit('state', state)
    this.adopt(state)
  }
  adopt(state) {
    if (!state?.live) return this.hangUp()
    if (state.epoch !== this.epoch) void this.watch(state.epoch)
  }
  async answered({ epoch, sdp }) {
    const pc = this.pc
    if (!pc || epoch !== this.epoch || pc.remoteDescription) return
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp })
    } catch {
      if (this.pc === pc) this.hangUp()
    }
  }
  async watch(epoch) {
    this.hangUp()
    this.epoch = epoch
    const pc = (this.pc = new RTCPeerConnection({ iceServers: this.iceServers }))
    const channel = pc.createDataChannel('qr', { ordered: false, maxRetransmits: 0 })
    channel.onmessage = (event) => this.receive(event.data)
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.ontrack = (event) => {
      if (this.pc !== pc) return
      this.stream = event.streams[0] ?? new MediaStream([event.track])
      this.emit('stream', this.stream)
    }
    // A failed connection, or an offer nobody answered (the camera was away), starts over.
    const again = (delay) => {
      clearTimeout(this.again)
      this.again = setTimeout(() => {
        if (this.pc !== pc || this.closed) return
        this.hangUp()
        this.adopt(this.last)
      }, delay)
    }
    pc.onconnectionstatechange = () => { if (this.pc === pc && pc.connectionState === 'failed') again(2000) }
    try {
      await pc.setLocalDescription(await pc.createOffer())
      await gatherICE(pc)
      if (this.pc !== pc) return
      this.line.send({ type: 'offer', epoch, sdp: pc.localDescription.sdp })
      again(15000)
      pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected' && this.pc === pc) clearTimeout(this.again) })
    } catch {
      if (this.pc === pc) again(2000)
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
    clearTimeout(this.again)
    this.pc?.close()
    this.pc = null
    this.epoch = ''
  }
  close() {
    this.closed = true
    clearTimeout(this.offline)
    this.line.close()
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
