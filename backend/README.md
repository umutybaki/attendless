# Attendless backend

Whoever creates a room is its camera; everyone who enters the room's six-digit code watches. The camera shares a silent feed (requested at 1280×720, up to 30 fps) and the links of the QR codes it reads. The frontend lives in `../public` ([DESIGN.md](../DESIGN.md)).

The camera scans full-resolution frames locally with jsQR up to 10 times per second, independently of the transmitted video. Each WebRTC video sender is capped at 1 Mbps and 30 fps, with `maintain-resolution` so bandwidth adaptation reduces frame rate before resolution. The camera requests 1280×720 at 30 fps; actual frame rate depends on the device and network. At 1 Mbps, video payload is about 75 MB per viewer per 10 minutes, plus protocol overhead; the phone uploads a separate stream to each viewer. QR links travel immediately over an unordered WebRTC data channel independently of the video. Only HTTP(S) links are clickable. The last scanned link remains visible, with its scan time, until a different QR link is scanned. Retaining a link does not extend the QR provider's validity. Viewers joining later receive the latest scan while the camera is connected. A reload keeps the room and its role; leaving clears the local link.

## Architecture

- Go AWS Lambda Function URL, one POST endpoint with an `action`: `create` and `join` (no token); `status`, `offer`, `connection` (viewer); `claim`, `heartbeat`, `release`, `end`, `peers`, `answer` (host only).
- DynamoDB on-demand table, one partition per room: `room:<code>/room` (owner hash, room id, lease, pause, ended), `session:<token hash>/session`, `room:<code>/viewer:<hash>` (presence) and `room:<code>/peer:<epoch>:<hash>` (SDP offer and answer). No images, QR content, audio, or recordings pass through AWS.
- Browser-to-browser WebRTC: camera video and decoded QR links. A public STUN server discovers connection addresses. There is no TURN relay or relay bill; restrictive networks that cannot establish a direct connection are outside this MVP.
- `create` writes the room with a condition, so a code is only issued when no live room holds it (ended or expired rooms free their code). Each room has a random id; sessions carry it, so a session from an earlier room under a reused code gets 410.
- Only the host session can claim the camera. Each claim has a new random generation (epoch). The camera renews a 12-second lease every two seconds, carrying the pause flag; leaving releases it immediately, an abrupt disconnect frees it within 12 seconds, and a stale claim cannot renew or release a newer one. Answers are fenced to the exact offer they answer.
- Viewers record presence on every `status` poll; the host's count includes viewers seen in the last 10 seconds. `end` marks the room ended and every session then gets 410.
- Rooms and sessions expire six hours after the host's last activity. The backend checks expiry and leases itself: DynamoDB TTL deletion is asynchronous and can take days. No provisioned Lambda concurrency or DynamoDB capacity.

Room codes are public and guessable, not access control. Tokens are random, kept in the browser's `sessionStorage` so a reload keeps the role, and stored server-side only as SHA-256 hashes. Never share secrets through a room. The API does not enforce a hard spending cap against public traffic.

## Development and deployment

Requirements: Go 1.25+ for backend development. Run `go test -race ./...` here. The tests use an in-memory store and require no AWS credentials.

From the repository root, `npm run build:backend` creates an ARM64 `bootstrap` executable and `.build/backend.zip` for the Lambda `provided.al2023` runtime. `infra/template.yaml` creates DynamoDB with TTL, the Lambda execution role and Function URL. `scripts/deploy.sh` uploads the ZIP, deploys the independent CloudFormation stack, and writes the URL into the static frontend's `config.js`.

The Lambda requires `TABLE_NAME`; AWS supplies its region and execution-role credentials. The frontend requires the public `ATTENDLESS_API_URL` at static build time. No Next.js environment variables or SST links remain. CORS permits the stack's CloudFront HTTPS origin, the custom domain and its `www` when `DomainName` is set, and localhost/127.0.0.1 port 3000. HTTPS is required for camera access outside localhost.

The stack runs in eu-central-1. See [DEPLOY.md](../DEPLOY.md) for the one-time AWS, Cloudflare and GitHub setup and the deployment order.

## Cost estimate

Working estimate: five 10-minute sessions/day, 30 days/month, five viewers in each. Each browser polls every two seconds only while in a room. This is approximately 360,000 Lambda calls/month, plus consistent DynamoDB reads for sessions, room state and signaling, and roughly 300,000 small writes (viewer presence on each poll, camera heartbeats) plus connection setup. At eu-central-1 on-demand rates (somewhat above us-east-1's), the incremental backend should stay around $1/month at this usage, excluding free-tier allowances; check current AWS pricing before relying on it. Actual duration, signaling size, latency, traffic and AWS pricing determine the bill. This estimate excludes the portfolio site's existing hosting, DNS/domain costs and taxes. There is no API Gateway, media relay, or AWS video egress bill.

## Manual acceptance check

1. On a phone, tap **New room** and allow the rear camera. Join from a second phone and a computer with the code, and with the invite link. A wrong code must fail; the camera must count both viewers.
2. Show QR A for two seconds, then remove it. Both viewers should see its clickable URL and a ticking age, and it should remain after removal. Show QR B: the link and age should update. A text QR or `javascript:` QR must never create a clickable link.
3. Pause, then resume: viewers see "Camera paused" and keep the last link. Reload each device: each returns to the same room in the same role.
4. Close the camera's tab without ending: viewers see the camera disconnect; reopening the site on that phone resumes the room. End the room (two taps): viewers see "Room ended", and the code no longer joins.
5. Test on ordinary Wi-Fi and mobile data, including iOS Safari and Android Chrome. Check outbound RTP stats: at most 30 fps and 1 Mbps per viewer. Mocked tests do not establish camera or network behavior.
