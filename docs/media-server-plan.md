# Plan: move video to a self-hosted media server

Status: proposal, nothing implemented yet. Video currently goes directly between devices (peer to peer, P2P).

## Goal

Replace the camera phone's direct connection to each viewer with **one** upload to a media server (an SFU, selective forwarding unit) on our Hetzner VPS. The server copies the stream to every viewer without re-encoding it. The goals are:

- **Less work for the camera phone.** It runs one video encoder instead of up to ten, and uploads about 0.5 Mbps instead of about 4 Mbps. Fixing that heat and battery cost is `REVIEW.md` release check 1.
- **Fewer failed connections.** Every device connects to a server with a public IP instead of to another phone behind NAT, so a TURN relay is rarely needed.

Room codes, joining, capacity, pause, expiry and the room's WebSocket **stay on Cloudflare** (Worker and Durable Objects). That part costs nothing at our load, keeps working through VPS restarts and runs close to Turkey. Only the media path moves.

## Non-goals

- Moving the Worker or Durable Objects to the VPS.
- Recording, audio, or more than one camera per room.
- End-to-end encryption for the first version. It's listed under open decisions.

## Architecture

```
            ┌──────────────── Cloudflare ────────────────┐
 camera ───▶│ Worker /api ──▶ Room Durable Object         │◀─── viewers
 (phone)    │  rooms, codes, capacity, pause, expiry,     │
            │  issues LiveKit access tokens, deletes      │
            │  LiveKit rooms on end/expiry                │
            └─────────────────────────────────────────────┘
    │ one video upload (WebRTC)               ▲ one video download each
    ▼                                         │
            ┌──────────── Hetzner VPS (Docker) ───────────┐
            │ Caddy  ── wss://rtc.<DOMAIN_NAME> ──▶ LiveKit│
            │ LiveKit (host network): UDP 7882, TCP 7881  │
            │ Alloy ── scrapes LiveKit + host ──▶ Grafana │
            └─────────────────────────────────────────────┘
```

- **Media server: [LiveKit](https://docs.livekit.io/home/self-hosting/)**, self-hosted. It's a single Go binary with an official Docker image and a JavaScript client SDK. It supports TURN, ICE over TCP and a single UDP port for all media, and exposes Prometheus metrics. Alternatives: mediasoup is a Node library with more code for us to write; Cloudflare Realtime SFU is managed but costs about $0.05/GB after 1,000 GB/month, roughly $217/month at our worst case.
- **The Durable Object stays the single source of truth** for who is in a room. It already enforces the ten-viewer limit, and the 4429 "room full" close and the 4409 "another tab took over" close stay the same. LiveKit only accepts people holding a token the room issued.
- **LiveKit room name = the room's random id**, not the six-digit code. A guessed code can't be used to reach media directly, and a code reused after a room ends gets a fresh media room.

## Capacity and cost

The modeled peak is 50 rooms at once × 10 viewers × about 0.48 Mbps, which is 400 kbps plus 20% overhead (see `scripts/cost.mjs`).

| | Peak | Month (3,300 rooms × 45 min) |
|---|---:|---:|
| VPS egress (to viewers) | ~240 Mbps | ~5.3 TB |
| VPS ingress (from cameras) | ~24 Mbps | ~0.5 TB |
| Camera phone upload | ~0.5 Mbps | ~0.16 GB per room |

- **Traffic:** Hetzner cloud servers in EU locations normally include 20 TB/month of egress (check the plan). 5.3 TB fits. So does 13 TB at a higher 1 Mbps quality.
- **CPU:** forwarding doesn't re-encode, but every packet is decrypted and re-encrypted. About 500 subscribed streams on 2 shared vCPUs is plausible but unproven, which is why phase 1 is a load test. Upgrading to a bigger Hetzner plan is cheap if needed.
- **Memory:** about 3 GiB is free. LiveKit at this size should stay well under 1 GiB.
- **Extra cost:** €0 while traffic stays inside the plan. Optional costs are a Floating IP (see port 443 below) and a larger plan if the load test fails.

## Phase 1: VPS setup and load test (about 1 day)

1. **DNS:** an `rtc.<DOMAIN_NAME>` record pointing at the VPS, not proxied by Cloudflare. WebRTC media can't go through Cloudflare's proxy.
2. **LiveKit service.** Draft below. Pin a current release and check its keys against that release's sample config.

   ```yaml
   # docker-compose.yml (attendless-media project)
   services:
     livekit:
       image: livekit/livekit-server:<pinned-version>
       network_mode: host        # media ports without Docker port mapping
       restart: unless-stopped
       command: --config /etc/livekit.yaml
       environment:
         LIVEKIT_KEYS: "${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
       volumes: ["./livekit.yaml:/etc/livekit.yaml:ro"]
       cpus: 1.5                 # leave headroom for the other production services on this box
       mem_limit: 1g
   ```

   ```yaml
   # livekit.yaml
   port: 7880                  # WebSocket signaling, reached only through Caddy
   prometheus_port: 6789       # scraped by Alloy, never public
   rtc:
     udp_port: 7882            # one UDP port for all media
     tcp_port: 7881            # ICE over TCP for networks that block UDP
     use_external_ip: true
   room:
     empty_timeout: 300
     max_participants: 11      # backstop; the Durable Object enforces 1 camera + 10 viewers
   turn:
     enabled: false            # see "Port 443" below
   logging:
     level: info
   ```

3. **Caddy:** add a site to the existing Caddy container. It runs on a Docker bridge network, so it reaches host-networked LiveKit through the host gateway. That needs `extra_hosts: ["host.docker.internal:host-gateway"]` on the Caddy service.

   ```
   rtc.<DOMAIN_NAME> {
   	respond /metrics* 404
   	reverse_proxy host.docker.internal:7880
   }
   ```

4. **Firewall:** ufw is inactive, and Docker-published ports bypass it anyway. So attach a **Hetzner Cloud Firewall** that allows only:
   - 22/tcp
   - 80/tcp
   - 443/tcp
   - 7881/tcp
   - 7882/udp

   Ports 7880 and 6789 must not be reachable from the internet.
5. **Monitoring:** add LiveKit (`host.docker.internal:6789`) and the host's CPU, steal time and network counters to the existing Alloy config, sending them to Grafana Cloud. Dashboard panels:
   - rooms and participants
   - packet loss and jitter
   - LiveKit and host CPU, including steal time
   - egress Mbps and month-to-date TB

   Alerts:
   - CPU above 80% for 5 minutes
   - projected monthly egress above 15 TB
   - LiveKit down
6. **Load test** with LiveKit's CLI (`lk load-test`), run from a **separate**, hourly-billed machine so the load generator doesn't distort the results. Simulate 50 rooms, each with 1 publisher at about 500 kbps and 15 fps and 10 subscribers, for 45 minutes.

   **Exit criteria:**
   - CPU including steal time stays below 70%
   - subscriber packet loss stays below 1%
   - LiveKit memory stays flat
   - the other services' health checks show no added latency

   If it fails, retest on the next plan size up before writing any app code.

## Phase 2: Worker and Durable Object (about 1–2 days)

1. **Configuration:**
   - `LIVEKIT_URL` (`wss://rtc.<DOMAIN_NAME>`) as a Worker variable
   - `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` as secrets, uploaded by `scripts/deploy.sh` the same way as the TURN keys
   - GitHub environment secrets for CI deploys

   **If any of the three is missing, rooms stay P2P.** That makes rollback a configuration change.
2. **Tokens** (`worker/livekit.js`, new): sign LiveKit access tokens as HS256 JWTs with `crypto.subtle`. Claims:
   - `iss`: the API key
   - `sub`: the identity
   - `nbf` and `exp`: a short TTL, e.g. 15 minutes; LiveKit refreshes tokens for connected participants
   - `video`: `{ room, roomJoin: true, canSubscribe: true, canPublish, canPublishData }`

   The camera gets `canPublish: true` and the fixed identity `camera`. LiveKit disconnects the older session when the same identity joins again, which matches the 4409 takeover. Viewers get `canPublish: false`, `canPublishData: false`, and their existing random `peer` id as identity.
3. **Welcome message** (`worker/room.js`): replace `iceServers` with a `media` field:
   - `{ mode: 'sfu', url, token, iceServers }`
   - or `{ mode: 'p2p', iceServers }`

   Keep `iceServers` from `worker/ice.js`: Cloudflare TURN on port 443 stays a fallback for networks that only allow TCP 443 (see below).
4. **Ending and expiring rooms:** on **End**, alarm expiry and grace expiry, call LiveKit's `RoomService/DeleteRoom` (`POST {LIVEKIT_URL→https}/twirp/livekit.RoomService/DeleteRoom` with an admin token). If the call fails, don't fail the room operation; LiveKit's `empty_timeout` cleans up after it. When a viewer socket closes, call `RemoveParticipant` so a viewer who left can't keep watching.
5. **Remove in SFU mode:** the offer/answer relay, offer throttling and stream generation (`epoch`) handling. Keep them while P2P is still supported.
6. **Unit tests** (`tests/worker.test.js`, plus a new `tests/livekit.test.js`):
   - the JWT matches a known test vector
   - the camera and viewers get the right permissions
   - full and takeover behavior is unchanged
   - DeleteRoom and RemoveParticipant are called with a fake `fetch`
   - with no LiveKit configuration, the room falls back to P2P

## Phase 3: Frontend (about 2 days)

1. **SDK:** add `livekit-client` (exact version) and copy its ESM build and license into `dist/vendor/` in `scripts/build.mjs`, the same way jsQR is handled. No CDN.
2. **CSP:** `index.html` has a static CSP. The build adds `wss://rtc.<DOMAIN_NAME>` (from `ATTENDLESS_LIVEKIT_URL`) to `connect-src`, and the smoke check verifies it.
3. **Camera** (`public/room.js`): when `media.mode === 'sfu'`, connect and publish one video track.
   - Encoding:
     - 960 px long edge
     - `maxFramerate: 15`
     - `maxBitrate` 400–800 kbps, decided from the load test
     - `degradationPreference: 'maintain-resolution'`
     - **no simulcast**, which would add encoders and undo the phone saving
   - The full-resolution local scanner in `public/camera.js` doesn't change.
   - **Pause** mutes the track; the Durable Object's `paused` state still drives the UI text.
4. **Viewers:** connect with subscribe-only permission, attach the camera's track to the existing `<video>`, and keep the current "paused", "disconnected" and "ended" screens driven by the room WebSocket.
5. **QR links:** send them as LiveKit reliable data messages from the camera. When a viewer joins, the camera sends the latest scan to that viewer only (`destinationIdentities`), which matches today's behavior. `safeQRLink` still checks every received link. Links then pass through the VPS instead of going directly between devices, but still never through Cloudflare.
6. **Keep the P2P code** until phase 5, with the mode chosen by the welcome message.

## Phase 4: Tests and CI (about 1–2 days)

- **Browser tests:** start `livekit-server --dev` (a pinned image, `docker run --network host`) in CI and locally. Extend `tests/browser/worker.spec.js` to cover:
  - the camera page publishes, two viewers receive frames, and QR links arrive
  - pause and resume
  - End disconnects everyone
  - an 11th viewer is refused
  - a reload keeps the role
- **Existing suites:** `room.spec.js` and `api.spec.js` keep running unchanged. Every test still fails on a CSP violation, which catches a missing `connect-src` entry.
- **Bundle check:** the Wrangler `--dry-run` step stays.

## Phase 5: Rollout (about 1 week, mostly waiting)

1. **Dev deployment:** deploy with LiveKit configured to a dev domain or a separate `workers.dev` deployment, pointing at the same VPS.
2. **Device checks:** rerun the manual acceptance check in `worker/README.md` with media through the VPS:
   - iOS Safari and Android Chrome
   - campus Wi-Fi and Turkish mobile data
   - one network that blocks UDP
   - a 45-minute ten-viewer session, checking phone temperature and battery against today's P2P numbers
3. **Production:** set the LiveKit secrets on production. Watch the Grafana dashboard for two weeks of real classes.
4. **Clean up:**
   - delete the P2P path (offer/answer relay, `gatherICE`, per-viewer peer connections)
   - update `README.md`, `worker/README.md` and `REVIEW.md`: the privacy wording, costs and the manual check

## Port 443 and strict networks

Caddy already holds TCP 443 on the VPS's single IPv4 address. Networks that allow only TCP 443 can't reach LiveKit's 7881/7882, and LiveKit's built-in TURN-over-TLS needs 443. Options, in order of preference:

1. **Keep Cloudflare TURN as a fallback** by passing `iceServers` to the LiveKit client (`rtcConfig`). Only the strictest networks use it, which should stay inside the free 1,000 GB/month. No VPS changes are needed. **This is the default.**
2. **Hetzner Floating IP** for LiveKit's TURN/TLS on 443, a few euros a month.
3. **Share port 443** by TLS hostname (Caddy with the layer4 module, or an nginx stream proxy). This is the most fragile option.

## Risks

| Risk | Mitigation |
|---|---|
| The server can see the video; it decrypts the media and could record it | Update the privacy wording in phase 5. Consider LiveKit end-to-end encryption later. Never enable recording. |
| One machine for all video: an outage or LiveKit restart interrupts every room | Update LiveKit outside class hours only. Monitor and alert. P2P fallback through configuration during the transition. The SDK reconnects automatically. |
| CPU contention with the other production services on the box | `cpus`/`mem_limit` on LiveKit. Phase 1 exit criteria include the other services' latency. Move to a dedicated box if needed. |
| Traffic goes past the plan's allowance | Projected-egress alert at 15 TB. Bitrate cap. Hetzner's overage is cheap. |
| Shared vCPU steal time during busy hours | Track steal in the dashboard. Switch to a dedicated-vCPU plan if it's above a few percent at peak. |
| Exposed media ports attract abuse | Tokens are required to join. Cloud Firewall allows only the media ports. Monitor LiveKit's connection counts. |

## Rollback

During phases 2–5, removing `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET` from the Worker and redeploying puts new rooms back on P2P. The frontend supports both modes until the clean-up step. After the clean-up, rollback means reverting that commit.

## Open decisions

1. **Domain** for `rtc.` (subdomain of the attendless domain or another one).
2. **Bitrate:** stay at 400 kbps, or use the phone's freed-up upload for 600–800 kbps, after the load test.
3. **Viewer limit:** it's now limited by the server, not the phone. Keep 10 or raise it?
4. **End-to-end encryption:** worth its phone CPU cost and complexity for this app?
5. **Analytics Engine metrics** for the Worker (the earlier Grafana plan): do them before phase 2 so P2P and the media server can be compared on real numbers.
