# Attendless

Share a silent phone camera feed with viewers and open scanned QR links on any device. The frontend is plain HTML, CSS and browser JavaScript, with no React, Next.js, Tailwind, bundler or frontend server in production. The browser libraries are [jsQR](https://github.com/cozmo/jsQR) (reading codes), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (draws the demo slide's QR; only `?demo` loads it). The static build copies their pinned scripts and licenses locally, with no CDN dependency. Optional cookieless analytics go to [Aptabase](https://aptabase.com) (EU region) only when a key is configured.

The app is English only. Creating a room makes your device the camera; up to ten people can enter its six-digit code to watch. Codes are public, not private access control.

Add `?demo` to try every screen without a camera. See [the backend notes](worker/README.md) for architecture and [the review](REVIEW.md) for verified fixes, remaining device checks and a three-university cost estimate.

## Development

Requirements: Node 22+ and npm.

```sh
npm ci
npm test
npm run dev          # http://localhost:3000, rooms between tabs of this browser
npm run dev:worker   # http://127.0.0.1:8787, the real Worker and rooms in local workerd
```

`npm run dev` has no API: rooms run between tabs of the same browser (put two windows side by side; background tabs are throttled). `npm run dev:worker` builds the site with the API at `/api` and runs the Worker, its Durable Objects and static files locally with Wrangler, so rooms behave as in production and video travels over WebRTC. Both bind to loopback. Local camera access works on localhost; a phone accessing a computer's LAN IP needs HTTPS. Production is HTTPS on Cloudflare. Do not use a production room for isolated test sessions.

```sh
npx playwright install --with-deps chromium
npm run test:e2e
```

Browser tests start both servers themselves; leave ports 3000 and 8787 free. `room.spec.js` runs rooms between tabs with demo mode's synthetic camera, `api.spec.js` runs them against a faked server and fake WebRTC, and `worker.spec.js` runs the real Worker: its protocol, then a camera page and a viewer page connected by real WebRTC. Every test fails on a Content Security Policy violation. To use an installed Chromium, set `CHROMIUM_PATH=/path/to/chromium`. None of this proves real device or carrier-network behavior.

## Deployment

One Cloudflare Worker serves everything: the static files in `dist/` (served without running the Worker, free and unlimited) and the room API under `/api/`, where each six-digit code is a [Durable Object](https://developers.cloudflare.com/durable-objects/). There is no database: a room keeps one small record in its own Durable Object storage. Everyone in a room holds one WebSocket, which sleeps between messages (the Hibernation API), so presence and pause need no polling and an idle room costs nothing. Only signaling passes through Cloudflare; video and QR links stay peer to peer, with an optional Cloudflare TURN relay for networks that block direct connections.

```sh
npm run deploy   # build, wrangler deploy, then a live smoke check
```

Deployment needs a Cloudflare account and Wrangler authentication. The script accepts `DOMAIN_NAME` to add the custom domain and `www`; TURN and analytics are optional. Every merge to `main` deploys after the tests pass. See [the review](REVIEW.md) for costs; the repository does not contain the previously referenced deployment guide.

## Layout

- `public/`: static frontend: English UI (`index.html`, `app.js`, `styles.css`), room transport (`room.js`), camera and scanner (`camera.js`), demo mode (`demo.js`), analytics (`analytics.js`), security headers (`_headers`).
- `worker/`: the Worker (`index.js`), the room Durable Object (`room.js`), TURN credentials (`ice.js`) and architecture notes.
- `wrangler.jsonc`: the Worker's configuration.
- `scripts/`: static build, local server, deployment and deployed smoke check.
- `tests/`: Node unit tests (including the room with a fake runtime) and Playwright browser tests.

The scanner reads the camera's full-resolution capture (1280×720 requested, 15 fps preferred) at up to 10 scans/sec. Viewers only need to see the scene, so each viewer's stream is capped at 400 kbps and 15 fps, and lowers its frame rate before its resolution. A room expires six hours after its camera was last connected; a camera that drops stays live for 15 seconds so a short reconnect doesn't interrupt viewers. Ending the room, leaving or closing the camera's page takes the camera off the air at once. The latest HTTP(S) QR link stays visible until another scan or leaving the room; its provider may have expired it.
