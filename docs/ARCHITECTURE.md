# Meldrift architecture

Status: `0.7.0-alpha.1` (M0–M6 complete: foundation, permanent UI, the M2
networking foundation, M3 real-time voice, M4 game streaming, M5 remote control
with player handoff, the M6 reliability and verification pass, and the P0 local
signaling deployment fix).

## Stack decisions

| Layer | Choice | Why |
| --- | --- | --- |
| Desktop shell | **Tauri 2** | MSVC + WebView2 are present on target machines; binary is ~10 MB versus ~120 MB for Electron, and the Rust core can own capture, input injection and audio without a second runtime. |
| UI | **React 19 + TypeScript + Vite** | Mature, fast HMR, strong typing across the IPC boundary. |
| State | **Zustand** | Selective subscriptions; a message arriving re-renders the chat list, not the shell. |
| Styling | **Hand-written CSS + tokens** | Zero runtime CSS cost and exact control over the reference design. No utility framework, no CSS-in-JS. |
| Icons | **Lucide** | Tree-shaken SVG set; the brand mark is a local SVG. |
| Persistence | **SQLite via rusqlite (bundled)** | Real relational data, WAL for non-blocking reads, no external database. |
| Networking | **Bun + bun:sqlite + WebSocket** | One compiled binary, no Node/native build step. The same binary runs as a bundled local Tauri sidecar (default, loopback only) or as a self-hosted HTTPS/WSS service for cross-PC play; the same TypeScript protocol file is imported by the client. |
| Voice | **WebRTC in WebView2 (Chromium)** | A maintained WebRTC stack with Opus, ICE, DTLS-SRTP, echo cancellation (AEC3), noise suppression and gain control already inside the WebView2 runtime. No extra native audio/WebRTC dependency, no second process, and the same code path on every Windows machine. See `docs/VOICE.md` for why not `webrtc-rs` + a native audio stack. |
| Video capture | **WebView2 `getDisplayMedia` (Windows Graphics Capture)** | Chromium's supported Win32 capture path, no full-resolution frame copies over IPC and no second capture/WebRTC stack. The same picker provides window and display sources. See `docs/STREAMING.md`. |
| Video transport | **WebRTC video-only peer connections, host → viewer mesh** | Reuses the WebView2 codec and ICE stack while keeping voice SDP independent. One connection per viewer, capped at four because the host uploads each encoded stream itself. |
| Remote input | **WebRTC data channel + Win32 `SendInput`** | Input needs a reliable, ordered, low-latency path that does not touch the signaling server. A dedicated SCTP data channel beside the existing WebRTC peers reuses ICE/DTLS; Rust injects with the supported Win32 API. See `docs/REMOTE_CONTROL.md`. |
| Tests | **Vitest** + Rust `#[cfg(test)]` | Fast unit/integration coverage on both sides of the IPC boundary. |

Deviations from the preferred stack: none. The only additions are Zustand (state
selection) and Lucide (icons); both are small and replaceable.

## Streaming boundary

M4 adds a second media plane without touching the M3 voice plane:

- Capture is WebView2 `getDisplayMedia`; window and display modes use different
  picker constraints and never switch silently.
- The host creates one video-only `RTCPeerConnection` per viewer. Voice peer
  connections and their SDP are never modified by video start/stop.
- The signaling service tracks an in-memory stream session per room (host, mode,
  preset, viewers) and relays SDP/ICE only between the authenticated host and its
  current viewers. Media stays peer-to-peer.
- The adaptive controller reads real sender/receiver stats every two seconds and
  adjusts bitrate, frame rate and scale through `setParameters`, not by
  recreating connections.
- Capture and connections are torn down when the track ends, the host stops or
  leaves, the socket drops, the user signs out or the app closes; viewers see a
  clear reconnect/error state rather than a frozen frame.

Details, limits and troubleshooting: `docs/STREAMING.md`.

## Module boundaries

```
src-tauri/                 Rust core — owns disk, Windows APIs, capture
  src/db.rs                Schema, migrations, CSPRNG invite codes
  src/models.rs            Wire models (serde camelCase both directions)
  src/commands.rs          Command surface + validation + tests
  src/signaling.rs         Bundled sidecar: port choice, readiness, restart, stop
  src/lib.rs               Builder, window lifecycle, command registration
  binaries/                Built sidecar (gitignored; `bun run server:build`)

server/                    Signaling service (Bun, self-hosted)
  src/db.ts                Server schema, invite codes, session tokens
  src/auth.ts              argon2id hashing, sessions, bearer extraction
  src/app.ts               HTTP routes, WebSocket fan-out, presence, limits
  src/index.ts             Bun.serve entry point
  test/api.test.ts         Integration tests against a real server

shared/protocol.ts         Wire types imported by both sides

src/
  lib/ipc.ts               DataPort interface + desktop/localStorage adapters
  lib/signaling.ts         Typed local-server bridge + session URL rebinding
  state/signaling.ts       Server readiness/mode/diagnostics store
  lib/model.ts             Types, validation, settings defaults, shared hooks
  lib/net/api.ts           Typed HTTP client for the signaling service
  lib/net/realtime.ts      Reconnecting socket: backoff, heartbeat, acks
  lib/net/map.ts           Pure wire ↔ UI mapping, message merging
  lib/net/hub.ts           Remote adapter seam used by the workspace store
  lib/voice.ts             Microphone capture graph + analyser metering
  lib/voice/model.ts       ICE parsing, speaking hysteresis, status derivation
  lib/voice/session.ts     WebRTC mesh: offers, answers, ICE, restart, cleanup
  lib/voice/transport.ts   Signaling seam installed by the network store
  lib/stream/model.ts      Capture bounds/presets, adaptive encoder, stats, errors
  lib/stream/session.ts    Host/viewer video peer connections
  lib/control/keys.ts      DOM code → scan code + virtual key, blocked shortcuts
  lib/control/input.ts     Frame validation, batching, held input, injection pump
  lib/control/session.ts   Controller/host input peer connections + data channel
  lib/control/desktop.ts   Typed Tauri bridge for arm/inject/release
  state/controlRoom.ts     Control session, queue, grants, lifecycle
  state/streamRoom.ts      Capture, viewer sessions, stats loops, lifecycle
  state/workspace.ts       Domain state and actions (local or server-backed)
  state/network.ts         Session, connection status, presence, requests
  state/ui.ts              Navigation, modals, toasts (never persisted)
  state/voice.ts           Capture state machine
  state/voiceRoom.ts       Voice session, participants, mute/deafen/PTT
  design/                  Tokens, base layer, primitives CSS
  components/              Button, Avatar, Modal, VirtualList, Menu, …
  app/                     Shell grid, title bar, rail, toasts, shortcuts
  features/                home, friends, rooms, room, chat, voice, settings,
                           onboarding, modals, palette, sidebar
```

Rules enforced by the layout:

1. **Screens never call `invoke`.** They call store actions; only `lib/ipc.ts`
   knows about Tauri.
2. **The Rust core never knows about React.** It accepts validated input and
   returns models.
3. **UI state is separate from domain state**, so a toast or a panel toggle can
   never rewrite the workspace.
4. **Voice capture is a singleton service** (`voiceEngine`), not component state,
   so navigation cannot interrupt a running session.

## Data flow

```
Screen → store action → DataPort → (Tauri command → SQLite) | (localStorage)
                   ↑                        │
                   └──────── models ────────┘
```

`DataPort` has two implementations with identical semantics: the SQLite adapter
for the desktop app and a `localStorage` adapter used by `bun run dev` and UI
previews. This keeps interface work fast without shipping mock data or a second
code path in the product.

## Connected mode

```
Screen → workspace action → (remote adapter set?) ─┬─ no  → DataPort → SQLite
                                                  └─ yes → HTTP/WS → server
                                    ▲                        │
                                    └──── events / acks ─────┘
```

Signed out, the app is local-only. Signed in, `state/network.ts` bootstraps the
server snapshot, opens a WebSocket and installs a `RemoteAdapter` in
`lib/net/hub.ts`. The workspace store checks that adapter in its actions, so
screens never branch on connectivity and the local database is left untouched.
The seam is a module, not an import from `workspace` to `network`, which keeps
the dependency graph acyclic (network → workspace → hub).

On launch the local workspace loads first and the stored session is applied
second, so a session restore always wins the final write. The session token is
stored in the local `session` table (plaintext for this alpha). Signing out
revokes it, clears it, closes the socket and reloads local data.

Delivery is acknowledgement-based: `message.send` resolves only on
`message.ack`, so the UI cannot show an unconfirmed write as delivered. The
socket reconnects with capped exponential backoff and a heartbeat; presence and
membership are pushed as events and applied to both stores.

See `docs/NETWORKING.md` for the endpoint table and protocol behaviour.

## Voice (M3)

Voice is a peer-to-peer mesh on top of the same authenticated WebSocket. The
signaling service does not carry audio; it only authorises and relays SDP and
ICE between people who are already in the same voice channel.

```
mic → getUserMedia → gain → analyser (meter) ─┐
                                     └→ MediaStreamDestination → RTCPeerConnection (Opus) → peer
peer → RTCPeerConnection → <audio> element + analyser (remote speaking level)
```

- **Why the WebView.** WebView2 is Chromium: WebRTC, Opus, ICE and DTLS-SRTP are
  already there, including platform-tuned AEC3, noise suppression, automatic
  gain control and jitter buffering. A Rust implementation using `webrtc-rs`
  plus `cpal` and a separate echo-cancellation library would add native threads,
  device hot-plug handling inside the process and a second WebRTC stack to keep
  current — significant risk for no audio-quality gain. Capture also stays off
  the UI thread inside Chromium's media pipeline.
- **Codec settings.** Opus, mono, 48 kHz, `maxBitrate = 48 kbps` per stream and
  DTX so silence costs almost nothing. Echo cancellation, noise suppression and
  AGC are requested through `getUserMedia` from user settings; no additional
  competing noise-suppression layer is applied in JS.
- **Topology.** One `RTCPeerConnection` per remote participant, capped at eight
  people by the server. Eight participants means seven upstream Opus streams
  per client (~340 kbps upstream); beyond that a mesh is the wrong shape and an
  SFU is required. The cap is enforced server-side, not just in the UI.
- **Offer direction.** The participant who joins later offers to each person
  already in the roster; existing participants answer. This removes glare
  without perfect negotiation, and a duplicate join replaces the existing
  membership instead of creating a second peer.
- **Signaling.** `voice.join` / `voice.leave` / `voice.state` from clients;
  `voice.joined` with the roster, `voice.participant.joined/left/state`,
  `voice.offer/answer/ice` routed only between two current voice members of the
  same room. The server validates room membership, both endpoints' voice
  membership, SDP/candidate sizes and a per-socket signaling rate (240
  messages / 10 s), and drops all voice state when the socket closes.
- **Reconnection.** The socket reconnects with capped exponential backoff and
  jitter. Voice membership is in-memory server state, so the client rejoins on
  reconnect and rebuilds peers whose signaling session was lost. Existing media
  can survive a signaling blip briefly; the UI reports `reconnecting` until the
  media path is connected again.
- **Truthful state.** `deriveVoiceStatus` combines signaling and every peer's
  real `RTCPeerConnection.connectionState`; `connected` requires all peers
  connected. Remote speaking comes from an analyser on the received audio with
  hysteresis, never from a timer or a random value.
- **Cleanup.** Leaving, switching rooms, signing out, closing the window and a
  microphone `ended` event all stop capture, close every peer connection, stop
  remote audio elements and send `voice.leave`. All peer objects are recreated
  on join, so repeated joins cannot accumulate connections.

## Persistence schema

`profile` (single row) · `settings` (single JSON document, sanitised in TS) ·
`rooms` · `friends` · `games` · `messages` (`scope_type` + `scope_id` for room
chat and DMs) with indexes on `(scope_type, scope_id, created_at)` and room
activity. Deleting a room or friend cascades its messages in the same command.

WAL mode, `synchronous=NORMAL`, `busy_timeout` 2.5 s. All input is validated in
Rust (lengths, enum values, scope ownership) and again in TS before submit.

## Performance strategy

- **No re-render storms.** Zustand selectors return the smallest slice; the voice
  level meter writes a CSS custom property per frame instead of setting React
  state.
- **Windowing.** `VirtualList` windows fixed-height collections (friends,
  members). Chat rows use `content-visibility: auto` with intrinsic sizing, which
  keeps long histories cheap without breaking variable-height messages.
- **Compositor-friendly motion.** Only `opacity` and `transform` are animated;
  durations are 110–220 ms and collapse to 0 under reduced motion.
- **No polling.** The analyser loop stops when capture stops, and a connected
  client sends one heartbeat every 25 s rather than polling for updates.
- **Voice off the render path.** Audio capture, Opus, echo cancellation and
  jitter buffering run inside Chromium's media pipeline; only a 120 ms analyser
  tick and a 250 ms speaking-state throttle touch the client stores. Chat and
  panel updates cannot block encoding or playback. `getStats` is not polled.
- **Measured, not claimed.** M6 recorded idle, voice, host, spectator,
  voice+stream and control profiles on the development machine, plus a 35-minute
  soak. The hardware, method and numbers are in `docs/M6_VERIFICATION.md`; they
  are not presented as universal hardware requirements.
- **Reconnect is repair, not hope.** A dropped socket reports `reconnecting`,
  re-fetches the authoritative roster and stream session, then closes peers that
  the new roster or stream no longer contains. A revoked token is detected by a
  slow HTTP session probe instead of retrying a 401 handshake forever.

## Windows specifics

- Frameless window with custom caption buttons; `data-tauri-drag-region` for
  dragging, double-click to maximise via the native toggle.
- Dark `backgroundColor` plus a `visible: false` window that is shown on page
  load, so there is no white flash. The reveal goes through `tauri::Window`,
  never `Webview`: `Webview::show` only makes the embedded WebView2 controller
  visible and leaves the OS window hidden with no taskbar entry
  (`0.6.0-alpha.1` shipped that mistake). A five-second watchdog reveals the
  window with an error title if no page ever loads, so a broken runtime cannot
  leave a silent process behind.
- WebView2 asks for microphone permission on the first join; denying it is
  handled as a real capture error (voice is not joined, and the app says the
  microphone is unavailable). The prompt is per WebView2 profile.
- Output selection uses `HTMLAudioElement.setSinkId` where WebView2 exposes it;
  otherwise the system default is used and the UI keeps the stored choice.
- CSP restricts scripts to self; media is limited to `self`, `blob:` and
  `mediastream:`. Connections allow `http:`/`https:`/`ws:`/`wss:` because the
  signaling server address is user-configured; that is the documented trade-off
  for self-hosting, and scripts remain restricted to `'self'`.

## Security model for remote input (implemented, M5)

Input forwarding exists only inside an explicit host grant:

1. The signaling service owns authority. The streaming host enables control for
   one named window, approves each controller from a FIFO queue, and can revoke
   or hand off. A grant has a random id, a 192-bit input token delivered only to
   the host and that controller, and a short expiry.
2. Signalling is relayed only between the current host socket and the current
   controller, with direction checks, SDP/ICE size limits and a per-socket rate
   limit. Revoked grant ids cannot be replayed.
3. Input travels on a dedicated ordered/reliable WebRTC data channel from the
   controller to the host. It never passes through the signaling service.
4. Rust refuses injection unless the chosen window is armed, still exists, is
   foreground and is not paused. A 400 ms watchdog pauses injection and releases
   held keys/buttons when focus leaves; closing or minimising the target
   invalidates the arm.
5. Every teardown path — revoke, release, handoff, either socket closing, stream
   stop, room leave, sign-out, target close/minimise, app exit — closes the
   channel and releases held input. `Ctrl+Alt+F12` is a global emergency stop.
6. Injection uses ordinary Win32 `SendInput`. Meldrift does not bypass DRM,
   anti-cheat or OS integrity boundaries, and cannot inject into elevated
   windows from a non-elevated process.

## Known architectural risks

- **Relay bandwidth is the real cost.** P2P covers one host to a few viewers;
  group fan-out needs an SFU. Self-hostable (LiveKit/mediasoup), but hosting is
  not free. Adaptive bitrate and subscriber caps must be honest in the UI.
- **Capture is WebView2's.** `getDisplayMedia` uses Chromium/Windows Graphics
  Capture and the browser's encoder choice. It works for ordinary windows and
  displays, but protected content and some exclusive-fullscreen surfaces cannot
  be captured. A future native capture path would trade that compatibility for
  codec and latency control; it is not needed for the current viewer caps.
- **Input injection vs. elevated games.** A non-elevated app cannot inject into an
  elevated process. This is a Windows limitation to document, not bypass.
- **Anti-cheat titles** may block synthetic input; Meldrift will state that
  rather than work around it.
