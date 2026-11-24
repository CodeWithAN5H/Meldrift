# Networking (M2)

Meldrift is local-first. Signed out, every room, message and friend lives in
SQLite on that PC. Signing in switches the workspace to a **signaling service**
you run yourself, so rooms and chat are shared with other PCs.

## What the service is

`server/` — one Bun process, one SQLite file, no external services.

- Accounts: argon2id password hashes, opaque 256-bit session tokens.
- Rooms with 7-character invite codes (`A–H`, `J–N`, `P–Z`, `2–9`).
- Room chat and direct messages, persisted server-side.
- Friends: request, accept, remove. DMs require an accepted friendship.
- Presence for friends and people who share a room. Nobody else sees it.
- WebSocket fan-out with per-message acknowledgement and heartbeats.

```
bun install --cwd server
cd server && bun run start          # http://127.0.0.1:8787
```

See `server/README.md` for environment variables, Docker and self-hosting notes.

## Wire protocol

`shared/protocol.ts` is imported by both the desktop client and the service, so
a protocol change breaks the build on whichever side was not updated.

| Transport | Purpose |
| --- | --- |
| `POST /api/auth/register`, `/login`, `/logout` | Account and session lifecycle |
| `GET /api/bootstrap` | Signed-in snapshot: user, rooms, friends, requests, conversations |
| `POST /api/rooms`, `/api/rooms/join` | Create a room / join by invite code |
| `GET /api/messages?scopeType=&scopeId=` | History for a room or conversation |
| `POST /api/friends`, `/accept`, `DELETE /api/friends/:id` | Friend lifecycle |
| `GET /api/dm/:peerId` | Get or create a conversation with a friend |
| `WS /ws?token=…` | `message.send` → `message.ack` / `message.new`, presence, membership |

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
```

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
  only broadcast to friends and room mates.

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

Automated: 10 server integration tests (auth, rate limit, rooms, fan-out,
membership rejection, DMs, friend gate, presence transitions) and 24 client
tests, including the address/merge/mapping logic.

## Limits in this milestone

- No room rename, delete or leave for server rooms yet. Local rooms still support
  rename and delete.
- Message history is fetched when a conversation opens; live delivery only
  reaches clients that are connected at that moment. Offline messages are stored
  and appear on the next open.
- Presence is online/offline/idle; there is no "away after inactivity" timer.
- No blocking, no unread counts, no typing indicators, no file uploads.
- One session per device; signing in on a second device does not revoke the
  first (each session token is independent and can be revoked by signing out).
- The service does not terminate TLS itself. Use Caddy, nginx or a tunnel.
