// Planning model, not a bill. Rates checked against Cloudflare docs 2026-11-01.
// Override the usage assumptions with environment variables, e.g.
// ROOMS_PER_UNIVERSITY=100 MINUTES=60 npm run cost
function setting(name, fallback, max = Infinity) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error(`Invalid ${name}`)
  return value
}
const universities = setting('UNIVERSITIES', 3)
const roomsPerUniversity = setting('ROOMS_PER_UNIVERSITY', 50)
const days = setting('DAYS', 22)
const viewers = setting('VIEWERS', 10, 10)
const minutes = setting('MINUTES', 45)
const bitrate = 400_000
const overhead = 1.2 // Planning allowance for RTP, DTLS, TURN and retransmission overhead.
const dailyRooms = universities * roomsPerUniversity
const monthlyRooms = dailyRooms * days
const viewerGB = bitrate * minutes * 60 / 8 / 1e9
const totalGB = monthlyRooms * viewers * viewerGB * overhead
const workerRequests = dailyRooms * (2 + 2 * viewers) // Create + host socket; join + socket per viewer.
console.log(JSON.stringify({
  assumptions: { universities, roomsPerUniversity, days, viewers, minutes, overheadPercent: Math.round((overhead - 1) * 100) },
  dailyRooms,
  monthlyRooms,
  baselineWorkerRequestsPerDay: workerRequests,
  workerFreeRequestAllowancePerDay: 100_000,
  hostVideoUploadMbps: viewers * bitrate / 1e6,
  hostUploadGBPerRoomWithOverhead: Number((viewers * viewerGB * overhead).toFixed(2)),
  monthlyVideoGBWithOverhead: Number(totalGB.toFixed(2)),
  turnScenarios: [0, 15, 50, 100].map((relayPercent) => {
    const relayGB = totalGB * relayPercent / 100
    return { relayPercent, relayGB: Number(relayGB.toFixed(2)), turnUSD: Number((Math.max(0, relayGB - 1000) * 0.05).toFixed(2)) }
  }),
}, null, 2))
console.log('Excludes domain, tax, analytics, other account usage, abuse and signaling retries. Add $5/month if using Workers Paid. Measure actual relay usage on campus networks.')
