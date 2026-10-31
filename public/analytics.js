// Product analytics through Aptabase, EU region. The SDK sets no cookies and
// stores nothing; its session id lives in memory and resets after an hour idle.
// It only loads when config.js carries a key, so development and tests send
// nothing. Demo mode and localhost report as debug data, kept apart from real
// use in the Aptabase dashboard.
//
// Events carry names and coarse properties only: never room codes, tokens,
// scanned links or their domains. DESIGN.md lists every event.
const key = window.ATTENDLESS_CONFIG?.aptabaseKey || ''
const debug = new URLSearchParams(location.search).has('demo') || ['localhost', '127.0.0.1'].includes(location.hostname)

const sdk = key
  ? import('./vendor/aptabase.js')
      .then((aptabase) => {
        // isDebug must be explicit: the SDK's fallback reads process.env, which a browser lacks.
        aptabase.init(key, { isDebug: debug })
        return aptabase
      })
      .catch(() => null)
  : Promise.resolve(null)

export function track(event, props) {
  void sdk.then((aptabase) => aptabase?.trackEvent(event, props)).catch(() => {})
}
