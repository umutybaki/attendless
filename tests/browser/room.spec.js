import { test, expect } from '@playwright/test'

// Rooms run between tabs of one browser until the backend exists, so every
// test opens its pages in one context. ?demo films a projected slide with a
// real, rotating QR code, which the camera page scans like a real frame.

async function typeCode(page, code) {
  for (const digit of code) await page.locator(`[data-digit="${digit}"]`).click()
}
async function createRoom(page) {
  await page.goto('/?demo')
  await page.getByRole('button', { name: 'New room' }).click()
  await expect(page.locator('#invite')).toBeVisible()
  const code = (await page.locator('#invite-code').textContent()).replace(/\D/g, '')
  expect(code).toMatch(/^\d{6}$/)
  return code
}

test('an unknown code is rejected and the next digit starts over', async ({ page }) => {
  await page.goto('/')
  await typeCode(page, '000123')
  await expect(page.getByRole('status').first()).toHaveText('No room with code 000 123. Check the digits.')
  await expect(page.locator('#code')).toHaveAttribute('data-state', 'error')
  await page.locator('[data-digit="7"]').click()
  await expect(page.locator('#code')).toHaveAttribute('data-state', 'idle')
  await expect(page.locator('.slot').first()).toHaveText('7')
})

test('the camera scans a QR code and a viewer gets its link', async ({ context }) => {
  const camera = await context.newPage()
  const code = await createRoom(camera)
  await expect(camera.getByRole('button', { name: 'Share invite' })).toBeVisible()
  await camera.getByRole('button', { name: 'Done' }).click()
  await expect(camera.locator('#reticle-label')).toHaveText('forms.example.com', { timeout: 15000 })
  await expect(camera.locator('#link-host')).toHaveText('forms.example.com')

  const viewer = await context.newPage()
  await viewer.goto('/')
  await typeCode(viewer, code)
  await expect(viewer.locator('#presence')).toHaveAttribute('data-presence', 'live')
  await expect(viewer.locator('#room-code-text')).toHaveText(`${code.slice(0, 3)} ${code.slice(3)}`)
  await expect(viewer.locator('#link-open')).toHaveAttribute('href', /^https:\/\/forms\.example\.com\/r\/[A-Z0-9]+$/)
  await expect(viewer.locator('#link-age')).toHaveText(/^\d+:\d\d$/)
  await expect.poll(() => viewer.evaluate(() => document.getElementById('feed').videoWidth)).toBeGreaterThan(0)
  await expect(camera.locator('#presence-text')).toHaveText(/^[1-9]\d* watching$/)
})

test('viewers ignore unsafe links and see the room end', async ({ context }) => {
  const camera = await context.newPage()
  const code = await createRoom(camera)
  const viewer = await context.newPage()
  await viewer.goto(`/?room=${code}`)
  await expect(viewer.locator('#presence')).toHaveAttribute('data-presence', 'live')
  await expect(viewer.locator('#link-open')).toHaveAttribute('href', /^https:\/\/forms\.example\.com\//, { timeout: 15000 })
  const before = await viewer.locator('#link-open').getAttribute('href')

  await camera.evaluate((code) => {
    const channel = new BroadcastChannel('attendless-rooms')
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@example.com/'])
      channel.postMessage({ type: 'link', code, from: 'intruder', link: { url, scannedAt: Date.now() + 60000 } })
    channel.close()
  }, code)
  await viewer.waitForTimeout(300)
  await expect(viewer.locator('#link-open')).toHaveAttribute('href', before)

  await camera.getByRole('button', { name: 'Done' }).click()
  await camera.getByRole('button', { name: 'End' }).click()
  await camera.getByRole('button', { name: 'Tap to end' }).click()
  await expect(camera.locator('#home')).toBeVisible()
  await expect(viewer.locator('#note-title')).toHaveText('Room ended')
  await viewer.getByRole('button', { name: 'Back to start' }).click()
  await expect(viewer.locator('#home')).toBeVisible()
})

test('every screen fits a small phone without scrolling', async ({ context }) => {
  const camera = await context.newPage()
  await camera.setViewportSize({ width: 320, height: 568 })
  const fits = (page) => page.evaluate(() => {
    const root = document.documentElement
    return root.scrollHeight <= innerHeight && root.scrollWidth <= innerWidth
  })
  await camera.goto('/?demo')
  expect(await fits(camera)).toBe(true)
  const code = await createRoom(camera)
  expect(await fits(camera)).toBe(true)

  const viewer = await context.newPage()
  await viewer.setViewportSize({ width: 320, height: 568 })
  await viewer.goto(`/?room=${code}`)
  await expect(viewer.locator('#link-open')).toHaveAttribute('href', /forms\.example\.com/, { timeout: 15000 })
  expect(await fits(viewer)).toBe(true)
  const dock = await viewer.locator('.dock').boundingBox()
  expect(dock.y + dock.height).toBeLessThanOrEqual(568)
})

test('a reload keeps the camera in its room', async ({ page }) => {
  const code = await createRoom(page)
  await page.reload()
  await expect(page.locator('#room-code-text')).toHaveText(`${code.slice(0, 3)} ${code.slice(3)}`)
  await expect(page.locator('#app')).toHaveAttribute('data-role', 'camera')
})
