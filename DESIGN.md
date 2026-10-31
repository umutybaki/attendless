# Attendless design

One phone points at a QR code. Everyone else in the room gets its link the moment the camera sees it. There are no accounts. A room is a six-digit code.

Try every screen on one machine with `npm run dev`, then open `http://localhost:3000/?demo`. Demo mode films a projected slide whose QR link changes every 12 seconds. The real scanner reads it, and any code you type joins a simulated room. Without `?demo` and without an API configured, rooms are real but only reach other tabs of the same browser (see [Rooms and the backend](#rooms-and-the-backend)). To try that, put two windows side by side: background tabs are throttled.

## Roles

There are two roles, and the choice on the first screen sets them:

| | Camera | Viewer |
|---|---|---|
| How you get it | Tap **New room** | Type a code, or open an invite link |
| How many | One per room: whoever created it | Any number |
| Sees | Full-bleed viewfinder, the reticle, the link it last sent, viewer count | The feed, the latest link and its age, live status |
| Controls | Invite, zoom 1×/2×/3×, flashlight, pause, end room | Open link, copy link, invite, leave |

Creator, host and camera are one person on purpose. A separate host, a moderator, or several cameras would each add a decision to every screen. None of them helps anyone get the link faster. If a phone dies, the room survives a reload, and viewers see "Camera disconnected" until it comes back.

Possible later additions, deliberately left out now: passing the camera to a viewer, a link history, auto-opening links (browsers block it anyway), locking a room.

## Screens and states

**Home** is a keypad. Six digits join automatically, with no Join button. The bottom-left key is **New room**, so both choices live on one surface and the system keyboard never opens. That keeps the layout fixed on phones: a system keyboard resizes the viewport. Physical keyboards and pasting a code or invite link also work.

- `idle`: caret on the next slot.
- `checking`: brackets close in on the code.
- `locked`: brackets turn yellow, then the room opens.
- `error`: the code shakes and turns red, with "No room with code 123 456". The next digit starts over.

**Room, camera.** Edge-to-edge viewfinder, glass controls on top.

- The **reticle** rests in the clear middle of the feed. When a code is in view, it jumps onto the code with a yellow domain chip, as the iOS camera does. A QR that is not a web link gets a grey reticle and "Not a web link". Nothing is sent.
- The **link strip** confirms what viewers got, and how long ago.
- **Invite** (tap the code): the code at large size, Share invite and Copy link. It opens by itself when the room is created. There is no join QR: viewers are somewhere else, which is why the app exists, so nobody can scan the host's screen. The invite has to travel as a message.
- **End** takes two taps (End, then Tap to end) instead of a dialog.
- **Pause** stops video and links. Viewers see "Camera paused" and keep the last link. On phones, leaving the tab pauses automatically, because the OS freezes the camera anyway. The screen is kept awake while sharing (Wake Lock).
- States: starting, blocked (with Try again), no camera, paused, live.

**Room, viewer.** Feed on top, the link card below. On desktop and in landscape, the card moves to a column on the right.

- **Link card.** The domain is shown at large size and the path in mono, so you can tell at a glance whether it's the link you expect. **Open link** is the only yellow thing on screen.
- **Link age** is a ticking `0:12`. It is yellow for the first 15 seconds and grey after that. Rotating QR codes expire, and this is the number that tells you whether to hurry.
- A new link flashes brackets around the card, vibrates on Android, and changes the tab title to "● New link" while the tab is in the background.
- States: waiting for the camera, live, paused, disconnected, room ended (with Back to start).

## UI system

Tokens live at the top of `public/styles.css`. Both themes are defined; the feed and everything drawn over it stay dark in both.

- **Motif: viewfinder corner brackets.** They frame whatever the app is locking onto: the code you type, the QR the camera sees, the newest link, the room code being shared. The `.brackets` utility draws them; `--b-color`, `--b-inset`, `--b-l` and `--b-t` animate them.
- **Accent: focus-lock yellow** (`--lock`). It appears only for "locked on" moments and the single primary action per screen: New room, Open link, Share invite. Live red (`--alert`) is semantic, not an accent.
- **Type.** The system UI face, so the app feels native. The system monospace face for codes, paths and the age readout, with tabular figures.
- **Surfaces.** Opaque keys and cards on the app background. Frosted glass (`.glass`) only over the camera feed.
- **Layout.** `#app` is `position: fixed; inset: 0`, and every view is a grid that fits the screen. Nothing scrolls. Pinch and double-tap zoom are blocked. Sizes use `clamp()` with `dvh`, so a 320×568 phone fits as well as a desktop. Safe-area insets are respected.

## Rooms and the backend

The UI talks to rooms only through `public/room.js`:

- `hostRoom(saved?)` returns `{ code, token, publish(stream, video), setState({ paused }), sendLink(link), end(), leave() }` and emits `viewers` and `ended`.
- `joinRoom(code, token?)` returns `null` for an unknown code, otherwise `{ code, token, welcomed, stream, start(), leave() }`, and emits `state`, `link`, `stream` and `ended`. It throws when the server can't be reached.

There are two transports behind that interface:

- **API** (used when `config.js` has an API URL; production uses `/api`). The Cloudflare Worker in `worker/` creates rooms under a random unused 6-digit code, one Durable Object per code. Creating returns the host token, stored only as a SHA-256 hash; joining returns a viewer token, which the room doesn't store at all.
  - Each page keeps one WebSocket to its room. The room pushes viewer counts and pause to everyone, and relays each viewer's offer to the camera and the answer back. Nobody polls; pings are answered without waking the room.
  - Only the host token can go live, pause or end the room. An ended or expired room closes every socket with "ended".
  - A camera whose socket drops stays live for 15 seconds, so a reconnect doesn't hang up its viewers.
  - Video and links go peer to peer over WebRTC, with links on an unordered data channel that repeats the latest one. Cloudflare's STUN finds addresses; with a TURN key configured, a Cloudflare TURN relay carries the connections that can't be direct.
  - Tokens live in `sessionStorage`, so a reload keeps your role.
- **Same browser** (no API configured). The room runs over a `BroadcastChannel`, with JPEG frames standing in for video. It's for development and the browser tests.

## Analytics

Aptabase (EU region) runs when `config.js` carries a key (`ATTENDLESS_APTABASE_KEY` at build time, the `APTABASE_APP_KEY` GitHub variable in production).

- **No cookies or storage.** `public/analytics.js` posts to Aptabase's event API directly. Its session ID lives in memory and resets after an hour idle, as in Aptabase's SDK.
- **Debug data is kept separate.** Demo mode and localhost report as debug data, which the Aptabase dashboard shows apart from real use.
- **Every event goes through `public/analytics.js`.** `api.spec.js` fails if a room code, token or scanned link ever appears in a payload.

| Event | Who | When | Properties |
|---|---|---|---|
| `room_created` | camera | a new room (not a reload) | `lang` |
| `camera_failed` | camera | first failure per room | `reason` (blocked, missing) |
| `invite_shared` | anyone | first share per room | `method` (share, copy), `role` |
| `room_closed` | camera | the camera leaves the room, once | `how` (end, leave, close, ended), `minutes`, `links`, `peak_viewers`, `first_link_seconds` (if a link was scanned) |
| `room_joined` | viewer | a join by code or invite (not a reload) | `via` (code, invite), `lang` |
| `join_failed` | viewer | first failure per visit | `via`, `reason` (not_found, unreachable) |
| `link_opened` | anyone | first open or copy per room | `action` (open, copy), `role` |

**Volume.** Aptabase's free plan counts events (20,000 a month), so each event answers one question once. A room with 1 camera and 4 viewers sends about 11 events: 3 from the camera (`room_created`, `invite_shared`, `room_closed`) and 2 per viewer (`room_joined`, `link_opened`). The earlier design sent about 18. At about 1,100 rooms a month of 1 camera and 6 viewers (a busy university), that is about 16,500 events, inside the free plan.

- **Milestones are summarized.** `room_closed` carries how long the room ran, how many links it sent, when the first one came and the peak audience, replacing separate `camera_started`, `first_link_scanned` and `room_ended` events. Rotating codes would otherwise add one event every few seconds.
- **Opens are not counted.** There is no `app_opened`: joining or creating already says someone came, and a reload no longer counts as a join.
- **Repeats are dropped.** A second copy of the same link, a second share or a second typo in one visit sends nothing.
- **The summary survives closing the tab.** When the page closes, `room_closed` (with `how: close`) goes out with `keepalive`. A reload also closes the page, so a reloaded camera sends one summary per page; `room_created` still counts the room once.

## Research

Patterns studied on Mobbin:

- Code entry: [Quizlet](https://mobbin.com/screens/a8192739-6109-4395-b0a9-c2b3d1ae437a), [Gmail](https://mobbin.com/screens/7dc64f76-998a-4432-88ef-679c08da0ec1), [Shangri-La Circle keypad](https://mobbin.com/screens/71c4d5d5-abc3-41f0-a00c-b9622909df22), [Paired](https://mobbin.com/screens/9db90a5d-e0ae-4c48-b3a9-5811753d5eb6).
- Scanners with a docked result: [Yuka](https://mobbin.com/screens/eee5a97d-2edb-440a-b8d7-85b477b27da1), [Glow](https://mobbin.com/screens/8214cd1b-3bf3-487d-85dc-7748307cb23b).
- Live hosting: [Telegram](https://mobbin.com/screens/0fa1d707-e6f0-4192-bd61-fae7431d310c), [X](https://mobbin.com/screens/e816374b-8a88-47b2-838b-1a9f5c875574).
- Invite sheets: [Splitwise](https://mobbin.com/screens/42bd144e-3f8f-462a-bb8c-4ccd3faeb025), [GoPay](https://mobbin.com/screens/e60ccc08-0b6d-47df-9b0c-000d3dedde8a). Both lead with a QR to scan in person, which this app's remote viewers can't use; only their share and copy actions carried over.
- Camera controls: [Cal AI](https://mobbin.com/screens/1931911e-97bc-4668-8c50-4dc5516e9c02), [Halide](https://mobbin.com/screens/c4554d5d-9a67-4797-a299-333b314a5fa1).

What changed because of it: almost every code screen opens a system keyboard that covers half the screen, so the keypad became the home screen. Scanners put the result in a sheet under the viewfinder, so the link card docks below the feed. Live-streaming hosts carry a lot of chrome, and only "Live" and the viewer count survived.
