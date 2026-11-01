import { iceServers as fetchIceServers, ICE_TTL_SECONDS, STUN } from './ice.js'

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
//              4409 another tab took over the session; 4400 a malformed hello;
//              4429 all ten viewer seats are in use.

export const GRACE_MS = 15_000 // A camera that drops stays "live" this long, so a blip doesn't hang up every viewer.
export const LIFETIME_MS = 6 * 3600_000 // A room expires six hours after its camera was last connected.
export const OFFER_EVERY_MS = 2_000 // At most one offer per viewer socket in this window.
export const MAX_VIEWERS = 10 // Each viewer costs the camera another video upload.
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
    // Hashing yields outside storage's input gate. Reserve the code before it
    // does, so two simultaneous creates cannot both return a host token.
    if (this.creating || this.active()) return json(409, { error: 'Code in use' })
    this.creating = true
    try {
      if (this.room) await this.finish()
      const token = randomHex(32)
      const now = this.now()
      await this.save({ id: randomHex(16), hostHash: await sha256(token), epoch: '', paused: false, hostAway: now })
      await this.ctx.storage.setAlarm(now + LIFETIME_MS)
      return json(200, { token })
    } finally {
      this.creating = false
    }
  }

  // Viewers are anonymous: a viewer token is the room's id plus a random part,
  // so the room stores nothing per viewer. A token from an earlier room under
  // the same code no longer matches and is told the room ended.
  join() {
    if (!this.active()) return json(404, { error: 'No room with that code' })
    if (this.sockets('viewer').length >= MAX_VIEWERS) return json(409, { error: 'Room full' })
    return json(200, { token: `${this.room.id}.${randomHex(16)}` })
  }

  accept() {
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    this.attach(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  attach(ws) {
    ws.serializeAttachment({ role: '', roomId: this.room?.id, peer: randomHex(16), offeredAt: 0 })
    if (!this.active()) ws.close(4410, 'Room ended')
  }

  // ---------- WebSocket events (the object may have hibernated in between) ----------

  async webSocketMessage(ws, data) {
    if (ws.readyState !== 1) return
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return ws.close(1009, 'Too large')
    let message
    try { message = JSON.parse(data) } catch { return }
    if (!message || typeof message !== 'object') return
    const me = ws.deserializeAttachment() ?? {}
    if (me.roomId !== this.room?.id) return ws.close(4410, 'Room ended')
    if (!me.role) return this.hello(ws, me, message)
    if (!this.active()) return ws.close(4410, 'Room ended')
    if (me.role === 'host') return this.fromHost(ws, message)
    return this.fromViewer(ws, me, message)
  }

  async hello(ws, me, { type, token }) {
    if (type !== 'hello' || typeof token !== 'string' || token.length > 200) return ws.close(4400, 'Say hello first')
    if (!this.active()) return ws.close(4410, 'Room ended')
    const { id: roomId, hostHash } = this.room
    let role = ''
    if (token.length === 64 && (await sha256(token)) === hostHash) role = 'host'
    else if (new RegExp(`^${roomId}\\.[0-9a-f]{32}$`).test(token)) role = 'viewer'
    if (!this.active() || this.room.id !== roomId || ws.readyState !== 1) return ws.close(4410, 'Room ended')
    if (!role) return ws.close(4410, 'Room ended')
    if (role === 'viewer') {
      // A reconnect keeps its seat even if the old network socket is still
      // half open. The token's random suffix identifies the viewer in this room.
      me.peer = token.slice(roomId.length + 1)
      for (const other of this.sockets('viewer', ws)) {
        if (other.deserializeAttachment()?.peer !== me.peer) continue
        other.serializeAttachment({ ...other.deserializeAttachment(), role: '' })
        other.close(4409, 'Viewer opened elsewhere')
        this.sockets('host')[0]?.send(JSON.stringify({ type: 'gone', peer: me.peer }))
      }
      if (this.sockets('viewer').length >= MAX_VIEWERS) return ws.close(4429, 'Room full')
    }
    ws.serializeAttachment({ ...me, role })
    if (role === 'host') {
      for (const other of this.sockets('host', ws)) {
        other.serializeAttachment({ ...other.deserializeAttachment(), role: '' })
        other.close(4409, 'Camera opened elsewhere')
      }
    }
    const back = role === 'host' && Boolean(this.room.hostAway)
    if (back) await this.save({ ...this.room, hostAway: 0 })
    const iceServers = await this.iceServers()
    if (!this.active() || this.room.id !== roomId || ws.readyState !== 1 || ws.deserializeAttachment()?.role !== role) return
    // ICE can require an external request. State may have changed while waiting.
    ws.send(JSON.stringify({ type: 'welcome', role, state: this.state(), iceServers }))
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
    this.sockets('host')[0]?.send(JSON.stringify({ type: 'offer', peer: me.peer, epoch, sdp }))
  }

  async webSocketClose(ws) {
    await this.left(ws)
  }

  async webSocketError(ws) {
    await this.left(ws)
  }

  async left(ws) {
    const me = ws.deserializeAttachment() ?? {}
    // Error and close can both arrive, including after this code was reused.
    ws.serializeAttachment({ ...me, role: '' })
    if (!this.room || me.roomId !== this.room.id || !me.role) return
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
    this.icePending = null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  sockets(role, except = null) {
    return this.ctx.getWebSockets().filter((ws) => {
      const me = ws.deserializeAttachment()
      return ws !== except && ws.readyState === 1 && me?.role === role && me.roomId === this.room?.id
    })
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
      const me = ws.deserializeAttachment()
      if (ws === except || ws.readyState !== 1 || !me?.role || me.roomId !== this.room?.id) continue
      try { ws.send(text) } catch { /* Closing. */ }
    }
  }

  // TURN credentials are shared by everyone in the room and reissued well before they expire.
  async iceServers() {
    const now = this.now()
    if (this.ice && now < this.ice.until) return this.ice.servers
    if (this.icePending) return this.icePending
    const roomId = this.room?.id
    const pending = (async () => {
      let ice
      try {
        ice = { servers: await this.fetchIce(this.env), until: now + ICE_REFRESH_MS }
      } catch (error) {
        console.error('TURN credentials unavailable', error?.message)
        ice = { servers: STUN, until: now + 60_000 }
      }
      // Ending a room during the request must not recreate its deleted storage.
      if (this.room?.id === roomId) {
        this.ice = ice
        await this.ctx.storage.put('ice', ice)
      }
      return ice.servers
    })()
    this.icePending = pending
    try { return await pending } finally {
      if (this.icePending === pending) this.icePending = null
    }
  }
}
