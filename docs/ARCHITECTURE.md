# Meldrift architecture

Status: `0.2.0-alpha.1` (M0, M1 and the M2 networking foundation complete).

## Stack decisions

| Layer | Choice | Why |
| --- | --- | --- |
| Desktop shell | **Tauri 2** | MSVC + WebView2 are present on target machines; binary is ~10 MB versus ~120 MB for Electron, and the Rust core can own capture, input injection and audio without a second runtime. |
| UI | **React 19 + TypeScript + Vite** | Mature, fast HMR, strong typing across the IPC boundary. |
| State | **Zustand** | Selective subscriptions; a message arriving re-renders the chat list, not the shell. |
| Styling | **Hand-written CSS + tokens** | Zero runtime CSS cost and exact control over the reference design. No utility framework, no CSS-in-JS. |
| Icons | **Lucide** | Tree-shaken SVG set; the brand mark is a local SVG. |
| Persistence | **SQLite via rusqlite (bundled)** | Real relational data, WAL for non-blocking reads, no external database. |
| Networking | **Bun + bun:sqlite + WebSocket** | One compiled binary, no Node/native build step, self-hostable; the same TypeScript protocol file is imported by the client. |
| Tests | **Vitest** + Rust `#[cfg(test)]` | Fast unit/integration coverage on both sides of the IPC boundary. |

Deviations from the preferred stack: none. The only additions are Zustand (state
selection) and Lucide (icons); both are small and replaceable.

## Module boundaries

```
src-tauri/                 Rust core — owns disk, Windows APIs, future capture
  src/db.rs                Schema, migrations, CSPRNG invite codes
  src/models.rs            Wire models (serde camelCase both directions)
  src/commands.rs          Command surface + validation + tests
  src/lib.rs               Builder, window lifecycle, command registration

server/                    Signaling service (Bun, self-hosted)
  src/db.ts                Server schema, invite codes, session tokens
  src/auth.ts              argon2id hashing, sessions, bearer extraction
  src/app.ts               HTTP routes, WebSocket fan-out, presence, limits
  src/index.ts             Bun.serve entry point
  test/api.test.ts         Integration tests against a real server

shared/protocol.ts         Wire types imported by both sides

src/
  lib/ipc.ts               DataPort interface + desktop/localStorage adapters
  lib/model.ts             Types, validation, settings defaults, shared hooks
  lib/net/api.ts           Typed HTTP client for the signaling service
  lib/net/realtime.ts      Reconnecting socket: backoff, heartbeat, acks
  lib/net/map.ts           Pure wire ↔ UI mapping, message merging
  lib/net/hub.ts           Remote adapter seam used by the workspace store
  lib/voice.ts             Microphone capture graph + analyser metering
  state/workspace.ts       Domain state and actions (local or server-backed)
  state/network.ts         Session, connection status, presence, requests
  state/ui.ts              Navigation, modals, toasts (never persisted)
  state/voice.ts           Capture state machine
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
- **Isolation for future media.** Streaming and voice will live outside React's
  render path: capture and encoding in Rust/worker threads, decoded video on its
  own `<video>` surface, UI in the WebView. A chat message can never block a frame.
- **Measured, not claimed.** Idle CPU/memory numbers will be recorded in
  `docs/STATUS.md` once profiling hardware runs are captured; none are asserted
  yet.

## Windows specifics

- Frameless window with custom caption buttons; `data-tauri-drag-region` for
  dragging, double-click to maximise via the native toggle.
- Dark `backgroundColor` plus a `visible: false` window that is shown on page
  load, so there is no white flash.
- CSP restricts scripts to self; media is limited to `self`, `blob:` and
  `mediastream:`. Connections allow `http:`/`https:`/`ws:`/`wss:` because the
  signaling server address is user-configured; that is the documented trade-off
  for self-hosting, and scripts remain restricted to `'self'`.

## Security model for remote input (planned, M5)

Design constraints fixed now so later code cannot quietly weaken them:

1. Input forwarding runs only while a **session grant token** issued by the host
   is valid, scoped to one room, one controller, one expiry.
2. The host process is the only authority: it maintains the allow-list, revokes
   on disconnect, and exposes an emergency stop (hotkey + dock control).
3. All injected input is normalised through a validator (key allow-list, absolute
   pointer clamping to the captured window rectangle) before reaching
   `SendInput`.
4. Grants are dropped on stream end, room leave, host lock, and app shutdown;
   input state (pressed keys/buttons) is released so nothing sticks.
5. Transport is WebRTC DataChannel with DTLS; signalling is authenticated (the
   M2 service already issues sessions and enforces room membership).
6. No anti-cheat bypass, DRM circumvention or process manipulation — only
   OS-level input APIs the user is entitled to use.

## Known architectural risks

- **Relay bandwidth is the real cost.** P2P covers one host to a few viewers;
  group fan-out needs an SFU. Self-hostable (LiveKit/mediasoup), but hosting is
  not free. Adaptive bitrate and subscriber caps must be honest in the UI.
- **Capture needs native code.** `Windows.Graphics.Capture` plus Media Foundation
  H.264 is the target; WebView2 screen capture alone cannot meet the latency and
  quality bar.
- **Input injection vs. elevated games.** A non-elevated app cannot inject into an
  elevated process. This is a Windows limitation to document, not bypass.
- **Anti-cheat titles** may block synthetic input; Meldrift will state that
  rather than work around it.
