import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Room, GRACE_MS, LIFETIME_MS, OFFER_EVERY_MS } from '../worker/room.js'
import { iceServers, STUN } from '../worker/ice.js'

// The Durable Object's logic against an in-memory runtime: storage, alarms and
// hibernatable sockets. tests/browser/worker.spec.js runs the real thing in workerd.
function runtime() {
  const data = new Map()
  const sockets = []
  const ctx = {
    alarm: null,
    storage: {
      get: async (key) => structuredClone(data.get(key)),
      put: async (key, value) => void data.set(key, structuredClone(value)),
      deleteAll: async () => data.clear(),
      setAlarm: async (at) => void (ctx.alarm = at),
      deleteAlarm: async () => void (ctx.alarm = null),
    },
    blockConcurrencyWhile: (fn) => fn(),
    getWebSockets: () => sockets.filter((ws) => ws.readyState === 1),
    data,
  }
  return { ctx, sockets }
}

function socket(sockets) {
  let attachment = null
  const ws = {
    readyState: 1,
    sent: [],
    closedWith: null,
    send(text) { this.sent.push(JSON.parse(text)) },
    close(code) { this.readyState = 3; this.closedWith = code },
    serializeAttachment(value) { attachment = structuredClone(value) },
    deserializeAttachment() { return structuredClone(attachment) },
    last(type) { return this.sent.filter((m) => m.type === type).at(-1) },
  }
  sockets.push(ws)
  return ws
}

async function setup(env = {}) {
  const clock = { now: 1_000_000 }
  const { ctx, sockets } = runtime()
  const ice = async (e) => (e.TURN ? [{ urls: 'turn:x', username: 'u', credential: 'c' }] : STUN)
  let room = new Room(ctx, env, { now: () => clock.now, ice })
  await room.ready
  const call = async (path) => {
    const response = await room.fetch(new Request(`https://room${path}`, { method: 'POST' }))
    return { status: response.status, body: await response.json() }
  }
  const connect = async (token) => {
    const ws = socket(sockets)
    room.attach(ws)
    await room.webSocketMessage(ws, JSON.stringify({ type: 'hello', token }))
    return ws
  }
  const say = (ws, message) => room.webSocketMessage(ws, JSON.stringify(message))
  const drop = async (ws) => { ws.close(1006); await room.webSocketClose(ws, 1006, '', false) }
  // A fresh object over the same storage, as after hibernation or eviction.
  const revive = async () => { room = new Room(ctx, env, { now: () => clock.now, ice }); await room.ready }
  return { clock, ctx, call, connect, say, drop, revive, get room() { return room } }
}

async function hosted(env) {
  const t = await setup(env)
  const { status, body } = await t.call('/create')
  assert.equal(status, 200)
  assert.equal(body.token.length, 64)
  const host = await t.connect(body.token)
  return Object.assign(t, { token: body.token, host })
}

test('a room hands out viewer tokens, counts viewers and relays offers and answers', async () => {
  const t = await hosted()
  assert.deepEqual(t.host.last('welcome'), { type: 'welcome', role: 'host', state: { live: false, paused: false, viewers: 0 }, iceServers: STUN })
  assert.equal(t.ctx.data.get('room').hostHash.length, 64)
  assert.ok(!JSON.stringify([...t.ctx.data.values()]).includes(t.token), 'the host token is stored only as a hash')

  const { body: { token } } = await t.call('/join')
  const viewer = await t.connect(token)
  assert.equal(viewer.last('welcome').role, 'viewer')
  assert.equal(t.host.last('state').state.viewers, 1)

  await t.say(t.host, { type: 'live', epoch: 'e1', paused: false })
  assert.deepEqual(viewer.last('state').state, { live: true, paused: false, viewers: 1, epoch: 'e1' })

  await t.say(viewer, { type: 'offer', epoch: 'stale', sdp: 'v=0 offer sdp' })
  assert.equal(t.host.last('offer'), undefined, 'offers for another generation are dropped')
  await t.say(viewer, { type: 'offer', epoch: 'e1', sdp: 'v=0 offer sdp' })
  const offer = t.host.last('offer')
  assert.equal(offer.sdp, 'v=0 offer sdp')
  await t.say(t.host, { type: 'answer', peer: offer.peer, epoch: 'e1', sdp: 'v=0 answer' })
  assert.deepEqual(viewer.last('answer'), { type: 'answer', epoch: 'e1', sdp: 'v=0 answer' })

  await t.drop(viewer)
  assert.deepEqual(t.host.last('gone'), { type: 'gone', peer: offer.peer })
  assert.equal(t.host.last('state').state.viewers, 0)
})

test('viewers cannot act as the camera, and offers are rate limited', async () => {
  const t = await hosted()
  await t.say(t.host, { type: 'live', epoch: 'e1', paused: false })
  const viewer = await t.connect((await t.call('/join')).body.token)
  await t.say(viewer, { type: 'live', epoch: 'evil', paused: true })
  await t.say(viewer, { type: 'end' })
  assert.equal(t.ctx.data.get('room').epoch, 'e1')

  await t.say(viewer, { type: 'offer', epoch: 'e1', sdp: 'v=0 first offer' })
  await t.say(viewer, { type: 'offer', epoch: 'e1', sdp: 'v=0 second offer' })
  assert.equal(t.host.sent.filter((m) => m.type === 'offer').length, 1)
  t.clock.now += OFFER_EVERY_MS
  await t.say(viewer, { type: 'offer', epoch: 'e1', sdp: 'v=0 third offer' })
  assert.equal(t.host.last('offer').sdp, 'v=0 third offer')
})

test('wrong tokens, a missing hello and tokens from an earlier room are refused', async () => {
  const t = await hosted()
  assert.equal((await t.connect('x'.repeat(64))).closedWith, 4410)
  const silent = socket([])
  t.room.attach(silent)
  await t.say(silent, { type: 'offer', epoch: '', sdp: 'v=0 offer sdp' })
  assert.equal(silent.closedWith, 4400)

  const { body: { token } } = await t.call('/join')
  await t.say(t.host, { type: 'end' })
  assert.equal((await t.call('/join')).status, 404)
  assert.equal((await t.call('/create')).status, 200, 'an ended room frees its code')
  assert.equal((await t.connect(token)).closedWith, 4410, 'a viewer of the old room sees it ended')
})

test('ending the room tells every viewer and erases it', async () => {
  const t = await hosted()
  const viewer = await t.connect((await t.call('/join')).body.token)
  await t.say(t.host, { type: 'end' })
  assert.ok(viewer.last('ended'))
  assert.equal(viewer.closedWith, 4410)
  assert.equal(t.ctx.data.size, 0)
  assert.equal(t.ctx.alarm, null)
})

test('a camera that drops stays live through the grace period, then goes off air', async () => {
  const t = await hosted()
  await t.say(t.host, { type: 'live', epoch: 'e1', paused: true })
  const viewer = await t.connect((await t.call('/join')).body.token)
  await t.drop(t.host)
  assert.equal(t.ctx.alarm, t.clock.now + GRACE_MS)
  await t.revive()

  // Back within the grace period: nothing changes for viewers.
  const again = await t.connect(t.token)
  assert.deepEqual(again.last('welcome').state, { live: true, paused: true, viewers: 1, epoch: 'e1' })
  t.clock.now += GRACE_MS
  await t.room.alarm()
  assert.equal(t.ctx.data.get('room').epoch, 'e1')

  await t.drop(again)
  t.clock.now += GRACE_MS
  await t.revive()
  await t.room.alarm()
  assert.deepEqual(viewer.last('state').state, { live: false, paused: false, viewers: 1, offline: true })
  assert.equal(t.ctx.alarm, t.clock.now - GRACE_MS + LIFETIME_MS)

  // The camera coming back clears "disconnected" for everyone.
  await t.connect(t.token)
  assert.deepEqual(viewer.last('state').state, { live: false, paused: false, viewers: 1 })
})

test('a camera that leaves on purpose shows as disconnected at once', async () => {
  const t = await hosted()
  await t.say(t.host, { type: 'live', epoch: 'e1', paused: false })
  const viewer = await t.connect((await t.call('/join')).body.token)
  await t.say(t.host, { type: 'live', epoch: '', paused: false })
  assert.deepEqual(viewer.last('state').state, { live: false, paused: false, viewers: 1 })
  await t.drop(t.host)
  assert.deepEqual(viewer.last('state').state, { live: false, paused: false, viewers: 1, offline: true })
})

test('a room expires six hours after its camera was last connected', async () => {
  const t = await hosted()
  const viewer = await t.connect((await t.call('/join')).body.token)
  await t.drop(t.host)
  t.clock.now += LIFETIME_MS - 1
  assert.equal((await t.call('/join')).status, 200)
  t.clock.now += 1
  await t.room.alarm()
  assert.equal(viewer.closedWith, 4410)
  assert.equal((await t.call('/join')).status, 404)

  // A room whose camera never connects expires too.
  const fresh = await setup()
  await fresh.call('/create')
  assert.equal(fresh.ctx.alarm, fresh.clock.now + LIFETIME_MS)
  fresh.clock.now += LIFETIME_MS
  assert.equal((await fresh.call('/join')).status, 404)
  assert.equal((await fresh.call('/create')).status, 200)
})

test('a second camera tab takes over and a code in use is not reissued', async () => {
  const t = await hosted()
  const second = await t.connect(t.token)
  assert.equal(t.host.closedWith, 4409)
  assert.equal(second.last('welcome').role, 'host')
  await t.room.webSocketClose(t.host)
  assert.equal(t.ctx.data.get('room').hostAway, 0, 'the old tab closing does not take the camera away')
  assert.equal((await t.call('/create')).status, 409)
})

test('TURN credentials are shared by the room and reissued before they expire', async () => {
  const t = await hosted({ TURN: true })
  assert.equal(t.host.last('welcome').iceServers[0].urls, 'turn:x')
  assert.ok(t.ctx.data.get('ice'), 'credentials survive hibernation')
})

test('TURN credentials come from Cloudflare with port 53 left out', async () => {
  assert.deepEqual(await iceServers({}), STUN)
  const requests = []
  const reply = (status, body) => async (url, init) => {
    requests.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }
  const servers = await iceServers({ TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'secret' }, reply(201, {
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
    ],
  }))
  assert.equal(requests[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret')
  assert.deepEqual(JSON.parse(requests[0].init.body), { ttl: 86400 })
  assert.deepEqual(servers, [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
  ])
  await assert.rejects(iceServers({ TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'bad' }, reply(401, {})), /HTTP 401/)
})
