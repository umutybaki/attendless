// ICE servers for WebRTC: Cloudflare's free STUN always, plus short-lived
// Cloudflare TURN credentials when a TURN key is configured. ICE prefers a
// direct path, so TURN only carries (and bills) traffic for the viewers whose
// networks block direct connections.
export const ICE_TTL_SECONDS = 24 * 3600
export const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }]
const api = 'https://rtc.live.cloudflare.com/v1/turn/keys'

export async function iceServers(env, fetchImpl = fetch) {
  const { TURN_KEY_ID: id, TURN_KEY_API_TOKEN: secret } = env ?? {}
  if (!id || !secret) return STUN
  const request = (path) =>
    fetchImpl(`${api}/${encodeURIComponent(id)}/credentials/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: ICE_TTL_SECONDS }),
    })
  let response = await request('generate-ice-servers')
  // The older endpoint returns a single server object instead of a list.
  if (response.status === 404) response = await request('generate')
  if (!response.ok) throw new Error(`TURN credentials: HTTP ${response.status}`)
  const body = await response.json()
  const servers = [body.iceServers].flat().filter(Boolean).map((server) => ({
    ...server,
    // Browsers time out on port 53, so Cloudflare recommends leaving those URLs out.
    urls: [server.urls].flat().filter((url) => typeof url === 'string' && !/:53(\?|$)/.test(url)),
  })).filter((server) => server.urls.length)
  if (!servers.some((server) => server.urls.some((url) => url.startsWith('turn')))) throw new Error('TURN credentials: no TURN server returned')
  return servers.some((server) => server.urls.some((url) => url.startsWith('stun:'))) ? servers : [...STUN, ...servers]
}
