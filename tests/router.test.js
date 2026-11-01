import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../worker/index.js'

function env({ allowed = true, createAllowed = true } = {}) {
  const calls = []
  return {
    calls,
    API_RATE_LIMITER: { limit: async ({ key }) => { calls.push(['api', key]); return { success: allowed } } },
    CREATE_RATE_LIMITER: { limit: async ({ key }) => { calls.push(['create', key]); return { success: createAllowed } } },
    ROOMS: {
      idFromName: (code) => code,
      get: (code) => ({ fetch: async () => { calls.push(['room', code]); return Response.json({ token: 'test-token' }) } }),
    },
    ASSETS: { fetch: async () => new Response('asset') },
  }
}
const request = (path, headers = {}, method = 'POST', origin = 'https://attendless.example') => new Request(`${origin}${path}`, { method, headers })

test('production rejects foreign and localhost origins; local development permits loopback', async () => {
  for (const origin of ['https://elsewhere.example', 'http://localhost:3000', 'http://127.0.0.1:3000', 'null']) {
    const e = env()
    assert.equal((await worker.fetch(request('/api/rooms', { Origin: origin }), e)).status, 403)
    assert.deepEqual(e.calls, [])
  }
  assert.equal((await worker.fetch(request('/api/rooms', { Origin: 'http://localhost:3000' }, 'POST', 'http://127.0.0.1:8787'), env())).status, 200)
})

test('rate limits stop create, join and socket attempts before invoking storage', async () => {
  for (const path of ['/api/rooms', '/api/rooms/123456/join', '/api/rooms/123456/socket']) {
    const e = env({ allowed: false })
    const response = await worker.fetch(request(path, { 'CF-Connecting-IP': '203.0.113.1' }), e)
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('Retry-After'), '60')
    assert.deepEqual(e.calls, [['api', 'attendless:203.0.113.1']])
  }
  const e = env({ createAllowed: false })
  assert.equal((await worker.fetch(request('/api/rooms'), e)).status, 429)
  assert.ok(!e.calls.some(([type]) => type === 'room'))
})

test('static assets bypass the API and API methods are checked', async () => {
  const e = env({ allowed: false })
  assert.equal(await (await worker.fetch(request('/', {}, 'GET'), e)).text(), 'asset')
  assert.deepEqual(e.calls, [])
  assert.equal((await worker.fetch(request('/api/rooms/123456/socket', { Upgrade: 'websocket' }), env())).status, 405)
})
