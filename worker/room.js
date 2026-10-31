import { iceServers as fetchIceServers, ICE_TTL_SECONDS } from './ice.js'

// One Durable Object per six-digit code. It holds the room in memory and in its
// built-in storage (a single small record), and relays the few signaling
// messages a WebRTC connection needs. Video and QR links never pass through it.
//
// Everyone keeps one WebSocket open. With the Hibernation API the object sleeps
// between messages, so an idle room costs nothing; presence is simply the set
// of open sockets, so nobody polls. Keepalive pings are answered by the runtime
// without waking the object.
//
// Client -> room: hello {token}; host: live {epoch, paused}, answer {peer, epoch, sdp}, end;
//                 viewer: offer {epoch, sdp}. Text "ping" gets "pong".
// Room -> client: welcome {role, state, iceServers}, state {live, paused, viewers, epoch?, offline?},
//                 offer {peer, sdp} (to the host), answer {epoch, sdp} (to one viewer),
//                 gone {peer} (to the host), ended.
// Close codes: 4410 the room ended, expired, or the token belongs to another room;
//              4409 another tab took over the camera; 4400 a malformed hello.

export const GRACE_MS = 15_000 // A camera that drops stays "live" this long, so a blip doesn't hang up every viewer.
export const LIFETIME_MS = 6 * 3600_000 // A room expires six hours after its camera was last connected.
export const OFFER_EVERY_MS = 2_000 // At most one offer per viewer socket in this window.
const MAX_MESSAGE = 32_000
const MAX_SDP = 20_000
const ICE_REFRESH_MS = (ICE_TTL_SECONDS * 1000) / 3 // Reissue once a third of the TTL is used, so any socket gets ≥ 2/3 of it.

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)))
export async function sha256(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export class Room {
  constructor(ctx, env, { now = Date.now, ice = fetchIceServers } = {}) {
    Object.assign(this, { ctx, env, now, fetchIce: ice, room: null, ice: null })
    // Answered by the runtime itself: keeps connections alive without waking or billing the object.
    if (typeof WebSocketRequestResponsePair === 'function') ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) ?? null
      this.ice = (await ctx.storage.get('ice')) ?? null
    })
  }

  // ---------- HTTP, from the Worker ----------

  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/create' && request.method === 'POST') return this.create()
    if (pathname === '/join' && request.method === 'POST') return this.join()
    if (pathname === '/socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return this.accept()
    return json(404, { error: 'Not found' })
  }

  // A code is free when no room holds it, or its room ended or expired.
  async create() {
    if (this.active()) return json(409, { error: 'Code in use' })
    const token = randomHex(32)
    const now = this.now()
    await this.save({ id: randomHex(16), hostHash: await sha256(token), epoch: '', paused: false, hostAway: now })
    await this.ctx.storage.setAlarm(now + LIFETIME_MS)
    return json(200, { token })
  }

  // Viewers are anonymous: a viewer token is the room's id plus a random part,
  // so the room stores nothing per viewer. A token from an earlier room under
  // the same code no longer matches and is told the room ended.
  join() {
    if (!this.active()) return json(404, { error: 'No room with that code' })
    return json(200, { token: `${this.room.id}.${randomHex(16)}` })
  }

  accept() {
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    this.attach(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  attach(ws) {
    ws.serializeAttachment({ role: '', peer: randomHex(16), offeredAt: 0 })
    if (!this.active()) ws.close(4410, 'Room ended')
  }

  // ---------- WebSocket events (the object may have hibernated in between) ----------

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return ws.close(1009, 'Too large')
    let message
    try { message = JSON.parse(data) } catch { return }
    if (!message || typeof message !== 'object') return
    const me = ws.deserializeAttachment() ?? {}
    if (!me.role) return this.hello(ws, me, message)
    if (!this.active()) return ws.close(4410, 'Room ended')
    if (me.role === 'host') return this.fromHost(ws, message)
    return this.fromViewer(ws, me, message)
  }

  async hello(ws, me, { type, token }) {
    if (type !== 'hello' || typeof token !== 'string' || token.length > 200) return ws.close(4400, 'Say hello first')
    if (!this.active()) return ws.close(4410, 'Room ended')
    let role = ''
    if (token.length === 64 && (await sha256(token)) === this.room.hostHash) role = 'host'
    else if (token.startsWith(`${this.room.id}.`)) role = 'viewer'
    if (!role) return ws.close(4410, 'Room ended')
    ws.serializeAttachment({ ...me, role })
    if (role === 'host') {
      for (const other of this.sockets('host', ws)) other.close(4409, 'Camera opened elsewhere')
    }
    const back = role === 'host' && Boolean(this.room.hostAway)
    if (back) await this.save({ ...this.room, hostAway: 0 })
    ws.send(JSON.stringify({ type: 'welcome', role, state: this.state(), iceServers: await this.iceServers() }))
    if (role === 'viewer' || back) this.broadcast({ type: 'state', state: this.state() }, ws)
  }

  async fromHost(ws, message) {
    if (message.type === 'live') {
      const epoch = typeof message.epoch === 'string' ? message.epoch.slice(0, 64) : ''
      const paused = Boolean(message.paused) && Boolean(epoch)
      if (epoch === this.room.epoch && paused === this.room.paused) return
      await this.save({ ...this.room, epoch, paused })
      this.broadcast({ type: 'state', state: this.state() })
    } else if (message.type === 'answer') {
      const { peer, epoch, sdp } = message
      if (epoch !== this.room.epoch || typeof sdp !== 'string' || sdp.length > MAX_SDP) return
      const viewer = this.sockets('viewer').find((socket) => socket.deserializeAttachment()?.peer === peer)
      viewer?.send(JSON.stringify({ type: 'answer', epoch, sdp }))
    } else if (message.type === 'end') {
      await this.finish()
    }
  }

  fromViewer(ws, me, message) {
    if (message.type !== 'offer') return
    const { epoch, sdp } = message
    if (!this.room.epoch || epoch !== this.room.epoch || typeof sdp !== 'string' || sdp.length < 10 || sdp.length > MAX_SDP) return
    const now = this.now()
    if (now - me.offeredAt < OFFER_EVERY_MS) return
    ws.serializeAttachment({ ...me, offeredAt: now })
    // Without a connected camera the offer is dropped; the viewer offers again.
    this.sockets('host')[0]?.send(JSON.stringify({ type: 'offer', peer: me.peer, sdp }))
  }

  async webSocketClose(ws) {
    await this.left(ws)
  }

  async webSocketError(ws) {
    await this.left(ws)
  }

  async left(ws) {
    const me = ws.deserializeAttachment() ?? {}
    if (!this.room || !me.role) return
    if (me.role === 'viewer') {
      this.sockets('host')[0]?.send(JSON.stringify({ type: 'gone', peer: me.peer }))
      this.broadcast({ type: 'state', state: this.state(ws) }, ws)
    } else if (!this.sockets('host', ws).length) {
      const now = this.now()
      await this.save({ ...this.room, hostAway: now })
      await this.ctx.storage.setAlarm(now + (this.room.epoch ? GRACE_MS : LIFETIME_MS))
      // Off the air already (the camera left on purpose): viewers learn it's gone now.
      if (!this.room.epoch) this.broadcast({ type: 'state', state: this.state() })
    }
  }

  // Ends the camera's grace period, then the room's lifetime.
  async alarm() {
    if (!this.room) return
    const { hostAway, epoch } = this.room
    if (!hostAway) return
    const now = this.now()
    if (now - hostAway >= LIFETIME_MS) return this.finish()
    if (epoch && now - hostAway >= GRACE_MS) {
      await this.save({ ...this.room, epoch: '', paused: false })
      this.broadcast({ type: 'state', state: this.state() })
    }
    await this.ctx.storage.setAlarm(hostAway + (this.room.epoch ? GRACE_MS : LIFETIME_MS))
  }

  // ---------- Helpers ----------

  active() {
    return Boolean(this.room) && !(this.room.hostAway && this.now() - this.room.hostAway >= LIFETIME_MS)
  }

  async save(room) {
    this.room = room
    await this.ctx.storage.put('room', room)
  }

  async finish() {
    this.broadcast({ type: 'ended' })
    for (const ws of this.ctx.getWebSockets()) ws.close(4410, 'Room ended')
    this.room = null
    this.ice = null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  sockets(role, except = null) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === 1 && ws.deserializeAttachment()?.role === role)
  }

  state(except = null) {
    const live = Boolean(this.room?.epoch)
    const state = { live, paused: live && this.room.paused, viewers: this.sockets('viewer', except).length }
    if (live) state.epoch = this.room.epoch
    // Not live because the camera isn't connected at all, rather than not started or paused.
    else if (this.room?.hostAway) state.offline = true
    return state
  }

  broadcast(message, except = null) {
    const text = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== 1 || !ws.deserializeAttachment()?.role) continue
      try { ws.send(text) } catch { /* Closing. */ }
    }
  }

  // TURN credentials are shared by everyone in the room and reissued well before they expire.
  async iceServers() {
    const now = this.now()
    if (this.ice && now < this.ice.until) return this.ice.servers
    try {
      this.ice = { servers: await this.fetchIce(this.env), until: now + ICE_REFRESH_MS }
      await this.ctx.storage.put('ice', this.ice)
    } catch (error) {
      console.error('TURN credentials unavailable', error?.message)
      this.ice = { servers: await this.fetchIce({}), until: now + 60_000 }
    }
    return this.ice.servers
  }
}
