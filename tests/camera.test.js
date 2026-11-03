import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openCamera, scanRegion } from '../public/camera.js'

function device(t, { caps, rejectUpgrade = false } = {}) {
  let constraints
  const applied = []
  const track = {
    getConstraints: () => structuredClone(constraints),
    ...(caps ? { getCapabilities: () => caps } : {}),
    async applyConstraints(next) {
      applied.push(next)
      if (rejectUpgrade && applied.length === 1) throw new Error('Unsupported capture mode')
      constraints = next
    },
    stop: t.mock.fn(),
  }
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] }
  const getUserMedia = t.mock.fn(async (request) => {
    constraints = request.video
    return stream
  })
  t.mock.getter(globalThis, 'navigator', () => ({ mediaDevices: { getUserMedia } }))
  return { track, stream, getUserMedia, applied }
}

test('camera requests native detail and retains maximum capture settings through torch and zoom changes', async (t) => {
  const { track, stream, getUserMedia } = device(t, {
    caps: { width: { max: 4096 }, height: { max: 3072 }, torch: true, zoom: { min: 1, max: 3 } },
  })
  const camera = await openCamera()
  assert.equal(camera.stream, stream)
  assert.deepEqual(getUserMedia.mock.calls[0].arguments[0], {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 },
      resizeMode: { ideal: 'none' }, frameRate: { ideal: 30, max: 30 },
    },
  })
  for (const adjust of [() => camera.setTorch(true), () => camera.setZoom(2), () => camera.setTorch(false)]) {
    await adjust()
    assert.deepEqual(track.getConstraints().width, { ideal: 4096 })
    assert.deepEqual(track.getConstraints().height, { ideal: 3072 })
    assert.deepEqual(track.getConstraints().resizeMode, { ideal: 'none' })
    assert.deepEqual(track.getConstraints().frameRate, { ideal: 30, max: 30 })
  }
  camera.stop()
  assert.equal(track.stop.mock.callCount(), 1)
})

test('camera works without capability discovery', async (t) => {
  const { track, applied } = device(t)
  const camera = await openCamera()
  assert.equal(applied.length, 0)
  await camera.setTorch(true)
  assert.deepEqual(track.getConstraints().width, { ideal: 3840 })
})

test('a rejected resolution upgrade keeps the working capture and controls', async (t) => {
  const { track, stream } = device(t, { caps: { width: { max: 4096 }, height: { max: 3072 } }, rejectUpgrade: true })
  const camera = await openCamera()
  assert.equal(camera.stream, stream)
  await camera.setZoom(2)
  assert.deepEqual(track.getConstraints().width, { ideal: 3840 })
  assert.deepEqual(track.getConstraints().height, { ideal: 2160 })
})

test('scans alternate between the scaled whole view and original centre pixels, within a fixed budget', () => {
  assert.deepEqual(scanRegion(4032, 3024, 0), { sx: 0, sy: 0, sw: 4032, sh: 3024, w: 1280, h: 960 })
  assert.deepEqual(scanRegion(4032, 3024, 1), { sx: 1376, sy: 1032, sw: 1280, sh: 960, w: 1280, h: 960 })
  assert.deepEqual(scanRegion(2160, 3840, 1), { sx: 720, sy: 1280, sw: 720, sh: 1280, w: 720, h: 1280 })
  // A frame within the budget is always read whole, at its own resolution.
  assert.deepEqual(scanRegion(1280, 720, 1), { sx: 0, sy: 0, sw: 1280, sh: 720, w: 1280, h: 720 })
})
