# Networking (M2), voice (M3), stream (M4) and control signaling (M5)

Meldrift is local-first. Signed out, every room, message and friend lives in
SQLite on that PC. The desktop app also runs a **bundled signaling sidecar** on
loopback by default, so accounts, rooms and chat work on one PC without internet
or a separate server. Cross-PC play uses **Remote server mode** against one
shared signaling service you host yourself; everyone must point at the same
instance. See `docs/DEPLOYMENT.md`.

## Deployment modes

- **Local (default):** `meldrift-server.exe` is shipped in the installer, started
  and health-checked by the Rust core, restarted after crashes and killed on
  exit. It binds `127.0.0.1:8787–8796` only, uses
  `<app data>/server/meldrift.db`, and never falls back to a public interface.
- **Remote:** the local sidecar is stopped. The configured `https://` address is
  used exactly as entered; a public plain-`http` address is rejected. LAN/private
  http remains available for testing.

A stored session that points at the old fixed loopback port is rebound to the
sidecar's actual port in Local mode. Remote sessions are never rewritten to
localhost.

## What the service is

`server/` — one Bun process, one SQLite file, no external services.

- Accounts: argon2id password hashes, opaque 256-bit session tokens.
- Rooms with 7-character invite codes (`A–H`, `J–N`, `P–Z`, `2–9`).
- Room chat and direct messages, persisted server-side.
- Friends: request, accept, remove. DMs require an accepted friendship.
- Presence for friends and people who share a room. Nobody else sees it.
- WebSocket fan-out with per-message acknowledgement and heartbeats.
- Voice channels: in-memory voice membership per room, authorization for every
  signal, SDP/ICE relay between channel members only, and authenticated ICE
  (STUN/TURN) configuration. Audio never passes through the service.
- Stream sessions: one in-memory stream per room, only the room owner can start,
  only the host socket can stop/change quality, viewers opt in, at most four per
  room, and SDP/ICE relay only between the host and current viewers. Video never
  passes through the service.

```
bun install --cwd server
cd server && bun run start          # http://127.0.0.1:8787
```

For the desktop app, Local mode does this automatically through the bundled
sidecar. See `docs/DEPLOYMENT.md` for both modes, `server/README.md` for
environment variables, Docker and reverse-proxy notes.

## Wire protocol

`shared/protocol.ts` is imported by both the desktop client and the service, so
a protocol change breaks the build on whichever side was not updated.

| Transport | Purpose |
| --- | --- |
| `POST /api/auth/register`, `/login`, `/logout` | Account and session lifecycle |
| `GET /api/bootstrap` | Signed-in snapshot: user, rooms, friends, requests, conversations |
| `POST /api/rooms`, `/api/rooms/join` | Create a room / join by invite code |
| `DELETE /api/rooms/:id` | Host-only, permanent room deletion (members are notified over the socket) |
| `GET /api/messages?scopeType=&scopeId=` | History for a room or conversation |
| `POST /api/friends`, `/accept`, `DELETE /api/friends/:id` | Friend lifecycle |
| `GET /api/dm/:peerId` | Get or create a conversation with a friend |
| `GET /api/voice/ice` | Signed-in only: STUN/TURN servers and the voice cap |
| `WS /ws?token=…` | `message.send` → `message.ack` / `message.new`, presence, membership, voice signaling, stream lifecycle and video signaling |

The browser cannot set headers on a WebSocket, so the session token travels in
the query string for that one handshake. The service also accepts
`Authorization: Bearer` on HTTP requests.

## Client structure

```
src/lib/net/api.ts        Typed HTTP client; ApiError carries a status (0 = transport)
src/lib/net/realtime.ts   Reconnecting socket: backoff, heartbeat, ack promises
src/lib/net/map.ts        Pure wire ↔ UI model mapping and message merging
src/lib/net/hub.ts        The seam the workspace store uses to detect "online"
src/state/network.ts      Session, connection status, presence, requests, adapter
src/lib/signaling.ts      Typed bridge to the native local-server lifecycle
src/state/signaling.ts    Readiness, mode switching, retry and diagnostics
src/lib/stream/           Video presets/adaptation, stats, host and viewer peers
src/lib/control/          Key map, input frames, input peer sessions, Tauri bridge
src/state/streamRoom.ts   Capture, stream session, viewer stats, cleanup
src/state/controlRoom.ts  Controller/host control session, queue and cleanup
```

## Stream signaling (M4)

```
stream.start   host only (room owner); same host socket may update mode/preset
stream.stop    host socket only
stream.watch   member, not host, up to four distinct viewers
stream.unwatch viewer slot only
stream.preset  host socket only
stream.sync    asking for the current session snapshot
stream.offer/answer/ice  relayed between the host and one current viewer
```

SDP is capped at 60 kB, ICE candidates at 2 kB, and stream signaling is
rate-limited per socket (300 messages / 10 s). The server ends the stream when
the host socket closes and removes only the viewer whose socket closes. Stream
state is in-memory; media is peer-to-peer. Host upload grows with each viewer
(see `docs/STREAMING.md`).

## Control signaling (M5)

```
control.enable/disable   host socket only, requires a live stream and target label
control.request/cancel   member, not host; queue capped at eight, deduplicated
control.approve/reject   host socket only; approve also revokes any previous grant
control.revoke/release   host revoke / current controller release
control.active           host socket, current grant id only (input channel state)
control.sync             snapshot of the room's control session
control.offer/answer/ice relayed only between the host and current controller
```

Every event is checked against membership, stream ownership, the current grant
id, the sender's role in that grant and (for SDP/ICE) the expected direction and
target. Revoked grant ids are remembered, so a replayed old grant cannot reopen
control. SDP is capped at 60 kB, candidates at 1.2 kB, and control signalling
has a per-socket budget of 160 messages with a 40/s refill. Input never passes
through the server: the data channel is peer-to-peer and the host validates a
grant token plus increasing sequence numbers. Cleanup runs on revoke, release,
handoff, controller or host socket close, stream stop, room leave and sign-out.
See `docs/REMOTE_CONTROL.md`.

`workspace.ts` never imports `network.ts` (that would be a cycle). The network
store installs a `RemoteAdapter` in `hub.ts` while connected; workspace actions
check for it and route room/chat/friend calls through the server, otherwise they
use `DataPort` as before. Screens keep talking to the same store.

### Connection behaviour

- On launch, a stored session is loaded from SQLite (`session` table) after the
  local workspace loads, then bootstrap replaces rooms/friends with server data.
- The socket reconnects with capped exponential backoff (0.8 s → 20 s, ±15 %
  jitter) and reports `connecting` / `online` / `reconnecting` / `offline`.
- A 25 s ping keeps the channel alive; 70 s of silence forces a reconnect.
- Sending resolves only when the server acknowledges the write, so the UI never
  shows an unconfirmed message as delivered.
- Signing out revokes the token server-side, clears the stored session, closes
  the socket and reloads the local workspace. Local data is never deleted by
  signing in or out.

### Voice signaling (M3)

Voice uses the same socket and session. Membership is authorisation:

- `voice.join` requires persistent room membership, is idempotent (a duplicate
  join replaces the membership rather than creating a second one), moves the
  user out of any other voice channel and enforces an eight-participant cap.
- `voice.state` is accepted only from the socket that owns the current voice
  membership; it updates and broadcasts mute, deafen and speaking flags.
- `voice.offer`, `voice.answer` and `voice.ice` are relayed only when both
  endpoints are currently in the same voice channel on their current sockets.
  A room member who never joined voice, a stranger, or the sender itself is
  rejected with `voice.error`.
- SDP is limited to 60,000 characters, ICE candidates to 2,000, and voice
  signaling to 240 messages per socket per 10 seconds.
- Voice membership is in-memory and is removed on socket close, on `voice.leave`
  and when joining a different room's channel.
- `GET /api/voice/ice` returns configuration only to authenticated clients, so a
  TURN credential is never public.

On reconnect the client re-sends `voice.join`, rebuilds peers for the returned
roster and re-offers; the server has already lost the old membership when the
socket closed, so there is no stale participant. The dock reports
`Reconnecting…` until real peer connections are connected again.

See `docs/VOICE.md` for the full flow, NAT/TURN setup and costs.

## Security posture (alpha)

- Serve the service behind HTTPS before exposing it. Tokens are bearer
  credentials; the client upgrades to `wss://` automatically for `https://`.
- The desktop CSP allows `http:`, `https:`, `ws:` and `wss:` for connections
  because the server address is user-configured. This is the trade-off for
  self-hosting; scripts stay restricted to `'self'`.
- Rate limiting is per client address: 12 auth attempts per minute. Behind a
  reverse proxy set `MELDRIFT_TRUST_PROXY=1` so `X-Forwarded-For` is used;
  otherwise every client shares the proxy address.
- Session tokens are stored in the app's local SQLite database (plaintext at
  rest) for this alpha. Windows DPAPI wrapping is planned before beta.
- Authorization is enforced server-side: message reads and writes check room
  membership or conversation membership; DMs require friendship; presence is
  only broadcast to friends and room mates; voice signals require room
  membership plus current voice membership on the sending socket, and are only
  relayed to other members of the same voice channel.
- TURN credentials are served only to signed-in clients through
  `GET /api/voice/ice`; they are not in public configuration or logs. Rotate
  them by restarting the service with new environment values.

## Verified

Against a real server on `127.0.0.1:8787` with two browser clients:

- register two accounts, both reach `Connected`;
- create a room, join it from an isolated second client by invite code;
- both clients show the same two-member list;
- a room message from the guest appears on the host in real time;
- a friend request arrives live and is accepted from the other client;
- both friends show each other as online;
- a direct message is delivered and shown to the recipient;
- signing out restores the local room and its history and hides the connection
  chip.

Voice, with two independent native clients on one machine against a fresh
server: both joined the same voice channel, the later joiner offered and the
existing participant answered, bidirectional audio was measured on both sides,
mute stopped transmission, deafen muted playback while RTP continued, leave and
rejoin left exactly one peer per side, and a server restart was followed by
`Reconnecting…`, automatic rejoin and audio again.

Automated: 25 server integration tests (auth, rate limit, rooms, fan-out,
membership rejection, DMs, friend gate, presence transitions, and 15 voice
authorization/routing/limit/cleanup cases) and 37 client tests, including the
address/merge/mapping and voice mesh logic.

## Limits in this milestone

- No room rename or leave for server rooms yet. The host can permanently delete
  a server room (the room row, its invite code and its messages); local rooms
  support rename and delete as before.
- Message history is fetched when a conversation opens; live delivery only
  reaches clients that are connected at that moment. Offline messages are stored
  and appear on the next open.
- Presence is online/offline/idle; there is no "away after inactivity" timer.
- No blocking, no unread counts, no typing indicators, no file uploads.
- One session per device; signing in on a second device does not revoke the
  first (each session token is independent and can be revoked by signing out).
- The service does not terminate TLS itself. Use Caddy, nginx or a tunnel.
- Voice is a mesh capped at eight people. The service relays signaling only; it
  is not an SFU and does not carry audio.
- No TURN server is bundled. The default STUN server covers friendly NATs only;
  strict NATs and restrictive firewalls need a TURN relay you host. See
  `docs/VOICE.md` for coturn, ports and bandwidth.
- Voice membership is live-only in memory; a server restart drops it and clients
  rejoin automatically.
- Two-machine, physical-microphone listening has not been tested; the native
  verification used synthetic tone input through the real capture path.
