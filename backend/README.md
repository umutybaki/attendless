# Attendance QR

A phone shares a silent camera feed (at least 1280×720, captured and shared at up to 30 fps) to viewers. Desktop browsers watch only. All users join with the MVP code **313131**. The standalone Attendless frontend lives in `../public`; use the deployed site root, or `?lang=tr` for Turkish.

The sharing phone scans full-resolution frames locally with jsQR up to 10 times per second, independently of the transmitted video. Each WebRTC video sender is capped at 1 Mbps and 30 fps, with `maintain-resolution` so bandwidth adaptation reduces frame rate before resolution. The camera requests 1280×720 at 30 fps; actual frame rate depends on the device and network. At 1 Mbps, video payload is about 75 MB per viewer per 10 minutes, plus protocol overhead; the phone uploads a separate stream to each viewer. QR links travel immediately over an unordered WebRTC data channel independently of the video. Only HTTP(S) links are clickable. The last scanned link remains visible, with its scan time, until a different QR link is scanned. Retaining a link does not extend the QR provider's validity. Viewers joining later receive the latest scan while the sharer is connected. A room change does not replay scans from a previous sharer. Leaving/rejoining clears the local link.

## Architecture

- Go AWS Lambda Function URL: joining, signaling, and a conditional DynamoDB sharing lease.
- DynamoDB on-demand table: sessions, current sharer, SDP offers and answers. No images, QR content, audio, or recordings pass through AWS.
- Browser-to-browser WebRTC: camera video and decoded QR links. A public STUN server discovers connection addresses. There is no TURN relay or relay bill; restrictive networks that cannot establish a direct connection are outside this MVP.
- First successful conditional claim wins. Each claim has a new random generation. The sharer renews a 12-second lease every two seconds; stopping normally releases it immediately. Closing the tab, hiding it, or a failed heartbeat stops sharing; an abrupt disconnect frees the slot within 12 seconds. A stale sharer cannot renew or release a replacement's lease.
- Sessions expire two hours after joining. Signaling and room items use a two-hour TTL, refreshed on room heartbeats. The backend checks session expiry and lease validity itself: DynamoDB TTL deletion is asynchronous and can take days. No provisioned Lambda concurrency or provisioned DynamoDB capacity.

The room code is public and intentionally fixed for this trial. It is not private access control. Session tokens stay in browser memory, are random, and are stored only as hashes. The backend checks ownership before returning viewer offers or accepting answers. Never put real secrets in the public room. This does not enforce a hard spending cap against public traffic.

## Development and deployment

Requirements: Go 1.25+ for backend development. Run `go test -race ./...` here. The tests use an in-memory store and require no AWS credentials.

From the repository root, `npm run build:backend` creates an ARM64 `bootstrap` executable and `.build/backend.zip` for the Lambda `provided.al2023` runtime. `infra/template.yaml` creates DynamoDB with TTL, the Lambda execution role and Function URL. `scripts/deploy.sh` uploads the ZIP, deploys the independent CloudFormation stack, and writes the URL into the static frontend's `config.js`.

The Lambda requires `TABLE_NAME`; AWS supplies its region and execution-role credentials. The frontend requires the public `ATTENDLESS_API_URL` at static build time. No Next.js environment variables or SST links remain. CORS permits the stack's CloudFront HTTPS origin and localhost/127.0.0.1 port 3000; add custom origins explicitly in the template. HTTPS is required for camera access outside localhost.

See [the migration guide](../MIGRATION.md) for AWS OIDC, GitHub variables and the deployment/cutover order.

## Cost estimate

Working estimate: five 10-minute sessions/day, 30 days/month, five viewers in each. Each browser polls every two seconds only while in a room. This is approximately 360,000 Lambda calls/month, plus consistent DynamoDB reads for sessions, room state and signaling; approximately 45,000 small heartbeat writes plus connection setup. At typical us-east-1 on-demand rates, the incremental backend should stay below $1/month at this usage, excluding free-tier allowances. Actual duration, signaling size, latency, traffic and AWS pricing determine the bill. This estimate excludes the portfolio site's existing hosting, DNS/domain costs and taxes. There is no API Gateway, media relay, or AWS video egress bill.

## Manual acceptance check

1. Join from a phone and a computer using 313131; an incorrect code must fail. The computer must have no Share camera button.
2. Start sharing on the phone, allow the rear camera, and join from a second phone. That phone must not be able to claim the occupied slot.
3. Show QR A for two seconds, then remove it. Both viewers should see its clickable URL and scan time, and it should remain after removal. Show QR B: the link and time should update. A text QR or `javascript:` QR must never create a clickable link.
4. Stop sharing and start from the second phone. Repeat after disconnecting the first phone without pressing Stop; the slot should become available within 12 seconds.
5. Test on ordinary Wi-Fi and mobile data, including iOS Safari/Android Chrome. Check camera settings and outbound RTP stats: minimum 720p source and at most 30 fps encoding and a 1 Mbps video bitrate cap per viewer. Multi-device camera and network testing requires a deployed backend; mocked tests do not establish this hardware behavior.
