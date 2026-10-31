const key = window.ATTENDLESS_CONFIG?.aptabaseKey || ''
const debug = new URLSearchParams(location.search).has('demo') || ['localhost', '127.0.0.1'].includes(location.hostname)
const endpoint = 'https://eu.aptabase.com/api/v0/event'
const idle = 3600_000
let session = '', lastAt = 0

function sessionId() {
  const now = Date.now()
  if (!session || now - lastAt > idle) session = `${Math.floor(now / 1000)}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  lastAt = now
  return session
}

export function track(eventName, props, { closing = false } = {}) {
  if (!key) return
  const body = JSON.stringify({
    timestamp: new Date().toISOString(),
    sessionId: sessionId(),
    eventName,
    systemProps: { locale: navigator.languages?.[0] ?? navigator.language, isDebug: debug, appVersion: '', sdkVersion: 'attendless-web@1' },
    props,
  })
  void fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'App-Key': key }, body, credentials: 'omit', keepalive: closing }).catch(() => {})
}
