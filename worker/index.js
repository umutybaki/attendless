import { Room } from './room.js'

export { Room }

// The Worker serves the static site (Cloudflare serves files in dist/ before
// the Worker runs; only /api/* reaches this code) and routes the API to one
// Durable Object per room code:
//
//   POST /api/rooms                 -> { code, token }   create a room; you are its camera
//   POST /api/rooms/:code/join      -> { token } | 404   join as a viewer
//   GET  /api/rooms/:code/socket    -> WebSocket         the room's live connection (see room.js)
const CODE_ATTEMPTS = 5
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0')

// Rooms run near their users: Turkey is closest to Eastern Europe.
const room = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code), { locationHint: 'eeur' })
const local = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    // The site and API share an origin. Browsers send Origin with WebSockets
    // (which have no CORS) and POSTs; refuse other sites. Non-browser clients send none.
    const origin = request.headers.get('Origin')
    if (origin && origin !== url.origin && !local(origin)) return json(403, { error: 'Forbidden origin' })
    try {
      if (url.pathname === '/api/rooms' && request.method === 'POST') return await create(env)
      const match = url.pathname.match(/^\/api\/rooms\/(\d{6})\/(join|socket)$/)
      if (!match) return json(404, { error: 'Not found' })
      const [, code, action] = match
      if (action === 'join' && request.method === 'POST') return await room(env, code).fetch('https://room/join', { method: 'POST' })
      if (action === 'socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        return await room(env, code).fetch('https://room/socket', { headers: request.headers })
      }
      return json(405, { error: 'Method not allowed' })
    } catch (error) {
      // Includes the free plan's daily limits: requests fail rather than bill.
      console.error(error?.message)
      return json(503, { error: 'Try again' })
    }
  },
}

async function create(env) {
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const code = randomCode()
    const response = await room(env, code).fetch('https://room/create', { method: 'POST' })
    if (response.status === 409) continue
    if (!response.ok) return json(503, { error: 'Try again' })
    const { token } = await response.json()
    return json(200, { code, token })
  }
  return json(503, { error: 'Try again' })
}
