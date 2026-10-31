export function safeQRLink(value) {
  if (typeof value !== 'string' || value.length > 4096) return ''
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : ''
  } catch {
    return ''
  }
}
export function isSharingPhone(
  nav,
) {
  return (
    /Android.*Mobile|iPhone|iPod/i.test(nav.userAgent) && nav.maxTouchPoints > 0
  )
}

export async function gatherICE(pc, ms = 5000) {
  if (pc.iceGatheringState === 'complete') return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      if (/a=candidate:/.test(pc.localDescription?.sdp ?? '')) resolve()
      else reject(new Error('ICE timeout'))
    }, ms)
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        cleanup()
        resolve()
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
    }
    pc.addEventListener('icegatheringstatechange', check)
    check()
  })
}
