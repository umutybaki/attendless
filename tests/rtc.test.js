import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeQRLink, isSharingPhone, gatherICE } from '../public/rtc.js'

test('only HTTP(S) links without credentials are accepted', () => {
  assert.equal(safeQRLink('https://example.com/check-in?a=1'), 'https://example.com/check-in?a=1')
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/test', 'https://user:password@example.com', 'plain text', null, 'https://example.com/' + 'x'.repeat(4096)]) {
    assert.equal(safeQRLink(value), '')
  }
})
test('only touchscreen phones can share', () => {
  for (const userAgent of ['Mozilla iPhone', 'Mozilla Android Mobile']) {
    assert.equal(isSharingPhone({ userAgent, maxTouchPoints: 5 }), true)
    assert.equal(isSharingPhone({ userAgent, maxTouchPoints: 0 }), false)
  }
  for (const userAgent of ['Mozilla Windows NT', 'Mozilla iPad', 'Mozilla Macintosh'])
    assert.equal(isSharingPhone({ userAgent, maxTouchPoints: 10 }), false)
})
test('ICE waits for gathering and removes the listener', async () => {
  const pc = new EventTarget()
  pc.iceGatheringState = 'gathering'
  const ready = gatherICE(pc)
  pc.iceGatheringState = 'complete'
  pc.dispatchEvent(new Event('icegatheringstatechange'))
  await ready
  await gatherICE(pc)
})
