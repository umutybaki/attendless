import { defineConfig, devices } from '@playwright/test'
const executablePath = process.env.CHROMIUM_PATH
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    // No API: room.spec.js uses the same-browser transport; api.spec.js fakes the server.
    { name: 'chromium', testIgnore: /worker\.spec\.js/, use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3000' } },
    // The real Worker and Durable Object in local workerd, with real WebRTC between pages.
    {
      name: 'worker',
      testMatch: /worker\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:8787',
        // Real host addresses instead of mDNS names, so two pages on one machine connect.
        launchOptions: { ...(executablePath ? { executablePath } : {}), args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] },
      },
    },
  ],
  webServer: [
    { command: 'npm run dev', url: 'http://127.0.0.1:3000', env: { ATTENDLESS_API_URL: '' }, reuseExistingServer: false },
    { command: 'npm run dev:worker', url: 'http://127.0.0.1:8787', env: { WRANGLER_SEND_METRICS: 'false' }, timeout: 120000, reuseExistingServer: false },
  ],
})
