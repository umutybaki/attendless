# Reliability and cost review

Reviewed 1 November 2026. Scope: the checked-in frontend, Cloudflare Worker, Durable Object room protocol, build/deploy configuration and automated tests. No production deployment, cloud account inventory or actual bill was inspected. The old AWS infrastructure mentioned in the previous README is not present here and its retirement has not been verified.

## Verified issues fixed

| Problem | Result |
| --- | --- |
| Two requests could create the same room concurrently while hashing the host token. | Reserve the code before yielding; only one request receives a valid host token. |
| Reusing an expired code could retain earlier viewers, and delayed socket events could modify the new room. | Close expired connections before reuse and bind every socket to the room's unique ID. |
| A replaced camera could send queued messages that changed or ended the current room. | Remove its authority immediately and ignore messages from closed sockets. |
| Error and close events for one camera could restart its disconnect grace period. | Process departure once. |
| A slow TURN request could send stale room state, issue duplicate requests or recreate storage after a room ended. | Share the pending request, use current state after it resolves, and verify the room ID before persisting. External requests have a timeout. |
| A viewer reconnecting its WebSocket kept a media connection the host had already discarded. | Negotiate again on welcome, and recover from persistent media disconnection as well as failure. |
| A fully subscribed room could refuse a reconnect while its earlier socket was half open. | A viewer's existing session reclaims its seat and replaces the earlier connection. |
| WebSocket upgrades and welcomes could stall indefinitely. | Bound the handshake wait and retry through the existing reconnect path. |
| A delayed camera permission result could publish into a later room. | Verify ownership after the asynchronous camera request and stop obsolete streams. |
| An OS-stopped camera track could leave the app looking live. | Stop publishing, show a camera-stopped message and offer a restart. |
| Restoring an expired camera session opened the camera before authentication failed. | Wait for the room welcome before entering the camera UI; clear an expired restore. |
| Existing room restoration overrode a new invite URL. | Follow the new invite when it identifies a different room. |
| Localhost origins were allowed against the production API. | Permit loopback exceptions only when the API is itself local. |
| Public create/join/socket endpoints had no request throttle. | Apply native Cloudflare rate limits before room storage is touched. |
| A camera could accept unlimited viewers and start one video upload per viewer. | Enforce ten viewers at both join and socket authentication; show a distinct full-room message. |

The app is now English only. Static labels and accessibility text live in `index.html`; dynamic messages live in `app.js`. The language switch, translation loading and `copy.js` were removed. Old language parameters are ignored and removed from the URL.

## Validation

- `npm test`: 24 passing tests. Five newly added lifecycle regressions were first run against the original implementation and failed before the fixes.
- `npm run test:e2e`: 20 passing tests in Chromium, including the real Worker protocol, real WebRTC video, a ten-viewer capacity check and reconnecting at capacity. Used `CHROMIUM_PATH` with a temporary downloaded headless browser on this machine.
- `ATTENDLESS_API_URL=/api npm run build` and `wrangler deploy --dry-run`: production assets and Worker configuration bundle successfully with both rate-limit bindings. No deployment was performed.
- `npm audit --omit=dev --audit-level=high`: no reported production dependency vulnerabilities.
- `git diff --check`: clean.

## Three-university budget

Run `npm run cost`; override assumptions with environment variables, for example `ROOMS_PER_UNIVERSITY=100 MINUTES=60 npm run cost`. This is a planning model, not a measured bill or a maximum spending guarantee.

Default assumptions: three universities, 50 rooms per university per weekday, 22 active days/month, ten viewers per room, 45 minutes per session, 400 kbps of video per viewer and 20% protocol/retransmission overhead. The relay percentage represents the share of viewer video volume carried over billable TURN egress. Actual usage may be lower with bitrate adaptation or higher with loss and retries.

| Measure | Estimate |
| --- | ---: |
| Rooms/day | 150 |
| Rooms/month | 3,300 |
| Worker requests/day before retries | 3,300 |
| Total viewer video/month including overhead | 5,346 GB |
| Camera upload with ten viewers, before overhead | 4 Mbps |
| Camera data per 45-minute room including overhead | 1.62 GB |

| Share of video relayed | TURN egress/month | Estimated TURN/month |
| --- | ---: | ---: |
| 0% | 0 GB | $0.00 |
| 15% | 801.90 GB | $0.00 |
| 50% | 2,673.00 GB | $83.65 |
| 100% | 5,346.00 GB | $217.30 |

Cloudflare charges $0.05/GB after the shared 1,000 GB/month Realtime allowance. Other SFU/TURN usage on the account consumes that allowance too. These estimates exclude domain registration, tax, analytics, other account workloads and abuse. [TURN pricing and billing definition](https://developers.cloudflare.com/realtime/turn/faq/).

Normal signaling should fit Workers Free at this usage. Static assets are free; Workers Free includes 100,000 dynamic requests/day. Workers Paid starts at $5/month. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Durable Objects have separate Free quotas: 100,000 requests/day, 13,000 GB-s/day, five million SQLite row reads/day, 100,000 row writes/day and 5 GB stored data. Incoming application messages receive a 20:1 request billing ratio; auto-responses avoid duration charges. Estimate roughly 30 DO requests per ordinary ten-viewer room, or 4,500/day, before retries. Duration, cold starts, external calls and storage must be checked in production metrics; the review does not establish their measured consumption. Free quota exhaustion interrupts service. [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Remaining release checks

1. Run a ten-viewer session on a representative iPhone and Android phone for 45 minutes. Check capture/scanning performance, temperature, battery drain and outbound bitrate. Ten independent encoders and the full-resolution scanner can be a phone bottleneck even when cloud costs are low.
2. Test each campus Wi-Fi network, mobile data, network switching, phone lock/unlock and camera interruption. The automated media test uses a synthetic camera on one machine. It does not establish Safari, carrier NAT or campus firewall behavior. TURN must be configured for networks that block direct WebRTC.
3. Measure TURN GB per viewer-minute in each university before calling the service free. At the modeled usage a 15% relay share fits the allowance, while a restrictive campus can approach the higher scenarios above.
4. Monitor Worker/DO errors, Free quota usage, room reconnects and TURN egress. The configured limits are 60 creates and 1,200 API attempts per minute per IP per location. Shared campus IPs can reach those thresholds; tune from real metrics. Cloudflare's limits are approximate and do not provide a hard global budget. [Rate-limit behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
5. TURN credentials delivered to public room clients can be reused outside the UI during their lifetime. The ten-viewer and 400 kbps limits constrain normal app behavior; they do not enforce a TURN account spending ceiling. Account-side usage monitoring and an operational response to abuse remain necessary. Rate limits reduce issuance abuse but do not revoke credentials already issued.
6. Room codes are intentionally public and guessable. This release does not add university authentication or private attendance access control.

The architecture is inexpensive for many small rooms if direct connections usually succeed. Phone capacity and the real relay percentage are the two factors that still need field measurements.
