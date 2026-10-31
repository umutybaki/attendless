# Attendless

Share a silent phone camera feed with viewers and open scanned QR links on any device. The frontend is plain HTML, CSS and browser JavaScript, with no React, Next.js, Tailwind, bundler or frontend server in production. [jsQR](https://github.com/cozmo/jsQR) is the sole browser library; the static build copies its pinned script and license locally, with no CDN dependency.

English is the default; `?lang=tr` selects Turkish. The trial room code is **313131**. Phones can share; desktop and tablet browsers watch. The code is public, not private access control.

## Development

Requirements: Node 22+, npm, Go 1.25+, and `zip` for Lambda packaging.

```sh
npm ci
npm test
(cd backend && go test -race ./...)
# Optional for UI work: use the ApiUrl output of your deployed stack.
ATTENDLESS_API_URL=https://YOUR_FUNCTION.lambda-url.us-east-1.on.aws/ npm run dev
```

Without `ATTENDLESS_API_URL`, the site still runs but room entry is disabled. The variable is a public endpoint, not a secret. The development server binds to loopback on port 3000. Local camera access works on localhost; a phone accessing a computer's LAN IP needs HTTPS. Production uses CloudFront HTTPS. Do not use a production room for isolated test sessions.

```sh
npx playwright install --with-deps chromium
npm run test:e2e
npm run build:backend
```

Browser tests start their own server with a mocked API, WebRTC and camera; leave port 3000 free. To use an installed Chromium, set `CHROMIUM_PATH=/path/to/chromium`. These tests verify signaling requests and controls, not real device interoperability.

## Static deployment

```sh
ATTENDLESS_API_URL=https://YOUR_FUNCTION.lambda-url.us-east-1.on.aws/ npm run build
```

Upload **the contents of `dist/`** to any HTTPS static host. There is no frontend compilation: the build copies files, the decoder and its license, and writes the endpoint into `config.js`. All scripts and styles are local. A different origin requires adding its exact origin to the Lambda Function URL CORS configuration in `infra/template.yaml`.

The included AWS deployment uses CloudFormation (no SST state), a private S3 bucket behind CloudFront, a Go ARM64 Lambda Function URL, and an on-demand DynamoDB table. The Lambda is packaged as a custom `provided.al2023` runtime. Only session hashes, leases and WebRTC signaling go through AWS; video and QR links stay peer to peer.

See [MIGRATION.md](MIGRATION.md) for AWS/GitHub setup, deployment, cutover, custom domains and rollback. The workflow deploys only after frontend, backend and infrastructure checks pass.

## Layout

- `public/`: static frontend, translations and WebRTC lifecycle.
- `backend/`: Go Lambda, existing protocol tests and architecture notes.
- `infra/template.yaml`: independent AWS stack.
- `scripts/`: static build, local server, Lambda packaging, deployment and deployed smoke check.
- `tests/`: Node unit tests and Playwright browser tests.

The scanner reads full-resolution frames at up to 10 scans/sec. The camera requests at least 720p and up to 30 fps; each viewer's stream is capped at 1 Mbps. There is no TURN relay, so restrictive networks can prevent direct connections. Sessions expire after two hours and the sharing lease after 12 seconds without a heartbeat. Stopping, leaving or hiding the sharing page stops the camera and releases its lease. The latest HTTP(S) QR link stays visible until another scan or leaving the room; its provider may have expired it.
