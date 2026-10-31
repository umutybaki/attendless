// Rooms travel over a BroadcastChannel until the backend exists: every tab of
// this browser can create and join rooms, but other devices cannot see them.
// The backend replaces this module behind the same interface:
//   hostRoom(code?)  -> { code, setState, sendLink, sendFrame, end } + 'viewers' events
//   joinRoom(code)   -> { code, welcomed, start, leave } + 'state', 'link', 'frame', 'ended' events, or null
const channelName = 'attendless-rooms'
const answerWithin = 800, pingEvery = 2000, staleAfter = 6500

const randomId = () => crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`

export function newCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0')
}

class Room extends EventTarget {
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
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }
  close() {
    clearInterval(this.timer)
    this.closed = true
    this.channel.close()
  }
}

// The camera's side: answers knocks, counts viewers, fans out state, links and frames.
class HostRoom extends Room {
  constructor(code) {
    super(code)
    this.viewers = new Map()
    this.state = { live: false, paused: false }
    this.link = null
    this.timer = setInterval(() => this.prune(), pingEvery)
  }
  receive(message) {
    if (message.type === 'knock')
      this.post('welcome', { to: message.from, state: this.snapshot(), link: this.link })
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
    for (const [id, seen] of this.viewers)
      if (Date.now() - seen > staleAfter) gone = this.viewers.delete(id) || gone
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
  setState(next) {
    Object.assign(this.state, next)
    this.post('state', { state: this.snapshot() })
  }
  sendLink(link) {
    this.link = link
    this.post('link', { link })
  }
  sendFrame(frame) {
    if (this.viewers.size) this.post('frame', { frame })
  }
  end() {
    this.post('ended')
    this.close()
  }
}

class ViewerRoom extends Room {
  receive(message) {
    if (message.type === 'welcome' && message.to === this.id) this.welcome?.(message)
    if (message.type === 'state') {
      this.seen = Date.now()
      this.last = message.state
      this.emit('state', message.state)
    }
    if (message.type === 'link') this.emit('link', message.link)
    if (message.type === 'frame') this.emit('frame', message.frame)
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
    }, pingEvery)
  }
  leave() {
    this.post('bye')
    this.close()
  }
}

export const hostRoom = (code = newCode()) => new HostRoom(code)

export async function joinRoom(code) {
  const room = new ViewerRoom(code)
  if (await room.knock()) return room
  room.close()
  return null
}
