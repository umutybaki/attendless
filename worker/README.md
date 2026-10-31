# Attendless backend

Whoever creates a room is its camera; everyone who enters the room's six-digit code watches. The camera shares a silent feed and the links of the QR codes it reads. The frontend lives in `../public` ([DESIGN.md](../DESIGN.md)).

The camera scans its full-resolution capture (1280×720 requested, 15 fps preferred) locally with jsQR up to 10 times per second, independently of the video it sends. Viewers only need to see the scene, so each WebRTC video sender is capped at 400 kbps and 15 fps, with `maintain-resolution` so bandwidth adaptation lowers the frame rate before the resolution. That is about 30 MB per viewer per 10 minutes at most, plus protocol overhead; the phone uploads a separate stream to each viewer. QR links travel immediately over an unordered WebRTC data channel independently of the video. Only HTTP(S) links are clickable. The last scanned link stays visible, with its scan time, until a different QR link is scanned. Keeping a link visible doesn't extend the QR provider's validity. Viewers joining later receive the latest scan while the camera is connected. A reload keeps the room and its role; leaving clears the local link.

## Architecture

- **One Cloudflare Worker** (`index.js`) serves the static site from `dist/` and the API under `/api/`. Static files are served without running the Worker. `POST /api/rooms` creates a room (the creator gets the host token), `POST /api/rooms/:code/join` returns a viewer token or 404, and `GET /api/rooms/:code/socket` opens the room's WebSocket. The API refuses requests whose `Origin` is another site (WebSockets have no CORS).
- **One Durable Object per code** (`room.js`), placed in Eastern Europe, nearest Turkey. It stores a single record in its own storage: the room's random id, the SHA-256 of the host token, the current stream generation (epoch), pause, and when the camera was last connected. Viewer tokens are the room id plus a random part, so the room stores nothing per viewer. There is no database, and nothing to clean up: an ended or expired room erases itself.
- **Everyone keeps one WebSocket** through the WebSocket Hibernation API. The object sleeps between messages, so an idle room costs nothing and nobody polls. Presence is the set of open sockets. Clients ping every 25 seconds to notice dead connections; the runtime answers without waking the object, and those pings are not billed. The message protocol is described at the top of `room.js`.
- **Signaling only.** The camera announces a stream generation; each viewer sends one offer for it, which the room relays to the camera; the camera's answer goes back to that viewer alone. Offers are limited to one per viewer socket every 2 seconds. When a viewer leaves, the camera is told to close that connection. No images, QR content, audio or recordings pass through Cloudflare.
- **ICE** (`ice.js`). Everyone gets Cloudflare's free STUN server. When `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` are set, the room also hands out Cloudflare TURN credentials (24-hour TTL, shared by the room and reissued after 8 hours; port 53 URLs left out because browsers time out on them). ICE prefers a direct path, so the relay only carries, and bills, the connections that can't be direct.
- **Lifetimes.** A camera that disconnects stays live for 15 seconds so a reconnect doesn't hang up its viewers; an alarm then takes it off the air. A room expires six hours after its camera was last connected, and a room whose camera never connected expires six hours after creation. Leaving or closing the camera's page takes it off the air at once; **End** erases the room and closes every socket. A second tab with the host token takes over the camera and closes the first. Expired and ended rooms free their code.

Room codes are public and guessable, not access control. Tokens are random and kept in the browser's `sessionStorage`, so a reload keeps the role. Never share secrets through a room.

## Development and deployment

`npm test` runs the room against an in-memory runtime (`tests/worker.test.js`); `npm run test:e2e` also runs the real Worker in local workerd (`tests/browser/worker.spec.js`). `npm run dev:worker` serves the site and API locally on port 8787. `npm run deploy` builds the site with the API at `/api`, deploys with Wrangler and runs `scripts/smoke.mjs` against the live site. See [DEPLOY.md](../DEPLOY.md).

## Cost

Everything here fits Cloudflare's **Workers Free plan**, which stops requests when a daily limit is reached rather than billing. A room with 1 camera and 6 viewers for 45 minutes uses roughly 17 Worker requests (the POSTs and WebSocket upgrades) and about 20 Durable Object requests: the same connections, WebSocket messages billed at 1/20 of a request each, and an alarm or two. Its compute time is a few seconds at most, because the object only runs while handling a message.

| | Free plan limit | One room | Rooms per day within it |
|---|---|---|---|
| Worker requests | 100,000/day | ≈ 17 | ≈ 5,800 |
| Durable Object requests | 100,000/day | ≈ 20 | ≈ 5,000 |
| Durable Object compute | 13,000 GB-s/day | ≲ 1.5 GB-s | ≈ 8,000 |
| Durable Object storage | 5 GB | < 1 KB while open | — |

A busy university (about 50 rooms a weekday, 1,100 a month) uses about 1% of these limits. Static files are free and unlimited.

The **TURN relay** is the only part that can bill: $0.05/GB after 1,000 GB a month free. If 15% of viewers need it, a room like the one above relays about 80 MB, so 1,100 rooms relay about 90 GB a month, which is free. Without TURN keys nothing can bill, but some restrictive networks can't connect.

## Manual acceptance check

1. On a phone, tap **New room** and allow the rear camera. Join from a second phone and a computer with the code, and with the invite link. A wrong code must fail; the camera must count both viewers.
2. Show QR A for two seconds, then remove it. Both viewers should see its clickable URL and a ticking age, and it should remain after removal. Show QR B: the link and age should update. A text QR or `javascript:` QR must never create a clickable link.
3. Pause, then resume: viewers see "Camera paused" and keep the last link. Reload each device: each returns to the same room in the same role.
4. Turn the camera phone's network off for five seconds and back on: viewers keep watching. Close the camera's tab without ending: viewers see "Camera disconnected"; reopening the site on that phone resumes the room. End the room (two taps): viewers see "Room ended", and the code no longer joins.
5. Test on ordinary Wi-Fi and Turkish mobile data, including iOS Safari and Android Chrome, and from a network that blocks direct connections (some campus or corporate Wi-Fi): with TURN keys set, it should still connect. Check outbound RTP stats: at most 15 fps and 400 kbps per viewer. Mocked tests do not establish camera or network behavior.
