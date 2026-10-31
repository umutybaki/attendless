import { test as base, expect } from '@playwright/test'

// Every test fails on a Content Security Policy violation or an uncaught page
// error, so the policy in index.html is exercised by the whole suite.
export const test = base.extend({
  context: async ({ context }, use) => {
    const problems = []
    context.on('console', (message) => {
      if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text())
    })
    context.on('weberror', (error) => problems.push(error.error().message))
    await use(context)
    expect(problems).toEqual([])
  },
})
export { expect }

export async function typeCode(page, code) {
  for (const digit of code) await page.locator(`[data-digit="${digit}"]`).click()
}
