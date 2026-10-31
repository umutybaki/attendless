# Attendless

Share a silent phone camera feed with viewers and open scanned QR links on any device. The frontend is plain HTML, CSS and browser JavaScript, with no React, Next.js, Tailwind, bundler or frontend server in production. The browser libraries are [jsQR](https://github.com/cozmo/jsQR) (reading codes) and [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (draws the demo slide's QR; only `?demo` loads it); the static build copies their pinned scripts and licenses locally, with no CDN dependency.

English is the default; `?lang=tr` selects Turkish. Creating a room makes your device the camera; everyone who enters its six-digit code watches. Codes are public, not private access control.

The product and UI are described in [DESIGN.md](DESIGN.md); first deployment, including the `attendless.app` domain, in [DEPLOY.md](DEPLOY.md). Add `?demo` to try every screen without a camera.

## Development

Requirements: Node 22+, npm, Go 1.25+, and `zip` for Lambda packaging.

```sh
npm ci
npm test
(cd backend && go test -race ./...)
# Optional for UI work: use the ApiUrl output of your deployed stack.
ATTENDLESS_API_URL=https://YOUR_FUNCTION.lambda-url.eu-central-1.on.aws/ npm run dev
```

Without `ATTENDLESS_API_URL`, rooms run between tabs of the same browser (put two windows side by side; background tabs are throttled). With it, rooms live on that API and video travels over WebRTC. The variable is a public endpoint, not a secret. The development server binds to loopback on port 3000. Local camera access works on localhost; a phone accessing a computer's LAN IP needs HTTPS. Production uses CloudFront HTTPS. Do not use a production room for isolated test sessions.

```sh
npx playwright install --with-deps chromium
npm run test:e2e
npm run build:backend
```

Browser tests start their own server; leave port 3000 free. `room.spec.js` runs rooms between tabs with demo mode's synthetic camera, and `api.spec.js` runs them against a mocked API with fake WebRTC. Every test fails on a Content Security Policy violation. To use an installed Chromium, set `CHROMIUM_PATH=/path/to/chromium`. These tests verify the UI, requests and signaling, not real device interoperability.

## Static deployment

```sh
ATTENDLESS_API_URL=https://YOUR_FUNCTION.lambda-url.eu-central-1.on.aws/ npm run build
```

Upload **the contents of `dist/`** to any HTTPS static host. There is no frontend compilation: the build copies files, the QR libraries, and writes the endpoint into `config.js`. All scripts and styles are local. A different origin requires adding its exact origin to the Lambda Function URL CORS configuration in `infra/template.yaml`.

The included AWS deployment uses CloudFormation (no SST state), a private S3 bucket behind CloudFront, a Go ARM64 Lambda Function URL, and an on-demand DynamoDB table. The Lambda is packaged as a custom `provided.al2023` runtime. Only session hashes, leases and WebRTC signaling go through AWS; video and QR links stay peer to peer.

Everything runs in eu-central-1 (Frankfurt), close to users in Turkey, except the domain's certificate, which CloudFront requires in us-east-1. See [DEPLOY.md](DEPLOY.md) for the one-time AWS, Cloudflare and GitHub setup, the first deployment and rollback, and [MIGRATION.md](MIGRATION.md) for retiring the portfolio's old service. The workflow deploys only after frontend, backend and infrastructure checks pass.

## Layout

- `public/`: static frontend: UI (`app.js`, `styles.css`), translations, room transport (`room.js`), camera and scanner (`camera.js`), demo mode (`demo.js`).
- `backend/`: Go Lambda, protocol tests and architecture notes.
- `infra/template.yaml`: the app stack (eu-central-1). `infra/bootstrap.yaml`: one-time artifact bucket and GitHub deploy role (eu-central-1). `infra/certificate.yaml`: the domain's certificate (us-east-1, as CloudFront requires).
- `scripts/`: static build, local server, Lambda packaging, deployment and deployed smoke check.
- `tests/`: Node unit tests and Playwright browser tests.

The scanner reads full-resolution frames at up to 10 scans/sec. The camera requests at least 720p and up to 30 fps; each viewer's stream is capped at 1 Mbps. There is no TURN relay, so restrictive networks can prevent direct connections. Rooms and sessions expire six hours after the host was last active, and the camera lease 12 seconds after its last heartbeat. Ending the room, leaving or closing the camera's page releases the lease at once. The latest HTTP(S) QR link stays visible until another scan or leaving the room; its provider may have expired it.
