# Meldrift signaling service

The service that makes rooms, presence, friends, chat, room voice and game
streaming between PCs. It is a single Bun binary with one SQLite file. The
desktop app bundles it as a loopback sidecar for Local mode; the same binary is
self-hosted for Remote mode. See `docs/DEPLOYMENT.md`.

```
bun install
MELDRIFT_DATA=./data/meldrift.db bun run start     # http://127.0.0.1:8787
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `MELDRIFT_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind TLS. |
| `MELDRIFT_PORT` | `8787` | Listen port. |
| `MELDRIFT_DATA` | `./data/meldrift.db` | SQLite file. WAL mode is enabled. |
| `MELDRIFT_TRUST_PROXY` | off | Set `1` **only** behind a proxy you control, so `X-Forwarded-For` is used for rate limiting. |
| `MELDRIFT_STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated `stun:`/`stuns:` URLs advertised to signed-in clients. |
| `MELDRIFT_TURN_URLS` | none | Comma-separated `turn:`/`turns:` URLs. |
| `MELDRIFT_TURN_USERNAME` | none | TURN username paired with the credential. |
| `MELDRIFT_TURN_CREDENTIAL` | none | TURN password or static-auth-secret credential. |

## What it does

- Accounts with argon2id password hashes and opaque 256-bit session tokens.
- Rooms with 7-character invite codes; joining is by code.
- Room chat and direct messages, persisted in SQLite.
- Friend requests, accept/remove, and presence for friends and people who share
  a room. Nobody else can see you.
- A WebSocket at `/ws?token=…` for fan-out, acknowledgements and heartbeats.
- Voice channels (M3): joins/leaves, participant state, and relayed
  offer/answer/ICE signaling. Every signal is checked against room membership,
  both endpoints' current voice membership, payload sizes and a per-socket rate
  limit; the channel cap is eight. Voice membership is in-memory and vanishes
  with the socket.
- `GET /api/voice/ice` for authenticated clients only: STUN/TURN configuration
  and the participant cap. Audio never passes through this service.
- Game streaming (M4): one in-memory stream per room, host-only start/stop and
  quality control, explicit viewer opt-in capped at four, and SDP/ICE relay only
  between the authenticated host and its current viewers. Video never passes
  through this service; host upload scales with viewer count.

Room deletion is host-only: `DELETE /api/rooms/:id` removes the room, its
messages and its invite code, and tells every connected member over the socket.

## What it does not do yet

Leaving a room (membership ends when the host deletes it), file uploads and game
audio capture. Remote control (M5) is supported: this service relays control
signaling only; input travels peer-to-peer and never through the server. Message
delivery is live-only: if both people are offline, the message is stored but
pushed to nobody until they reconnect and open the conversation. No TURN server
is bundled — configure one yourself if participants may be behind strict NATs.

## Voice relay configuration

```bash
MELDRIFT_TURN_URLS="turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349" \
MELDRIFT_TURN_USERNAME="meldrift" \
MELDRIFT_TURN_CREDENTIAL="change-me" \
bun run start
```

Open UDP/TCP 3478 and 5349 and the coturn relay range (for example UDP
49160–49200). Credentials are only returned to signed-in clients. Full setup,
ports, bandwidth and cost notes are in `docs/VOICE.md`.

## Tests

```
bun test
```

The suite starts a real HTTP + WebSocket server against an in-memory database and
covers registration, login, duplicate usernames, room creation and joining,
fan-out, membership enforcement, DMs, friend requests, presence transitions and
voice (ICE config auth, non-member and unknown-room rejection, duplicate joins,
offer/answer/ICE routing, invalid and oversized payloads, rate limiting, state
broadcast, leave/close cleanup, the eight-participant cap) and streaming
(host/member authorization, one stream per room, viewer opt-in/retry, four-viewer
cap, host-only preset control, SDP/ICE routing and limits, host/viewer cleanup)
and room deletion (host authorization, member notification, invite-code
retirement, already-deleted rooms and restart persistence). Currently 47 tests.

## Health

`GET /api/health` returns `{ ok, protocol, name: "meldrift-signaling", version,
 uptimeMs }`. It is public, contains no secrets and is what the desktop sidecar
waits for before enabling account controls.

## Self-hosting notes

- Put this behind HTTPS (Caddy, nginx, Cloudflare Tunnel) before exposing it.
  Session tokens are bearer credentials and the desktop client uses `wss://`
  automatically when the server URL is `https://`.
- `MELDRIFT_HOST=0.0.0.0` requires a firewall and TLS in front; the service
  itself does not terminate TLS.
- SQLite is enough for a friend group. There is no federation or sharding.
- Back up `meldrift.db` (plus its `-wal` file) if the messages matter.
- TURN is the only meaningful running cost for voice; direct peer-to-peer calls
  use this service for signaling only.

## Docker

```
docker build -f server/Dockerfile -t meldrift-server .
docker run -p 8787:8787 -v meldrift-data:/data meldrift-server
```

The build context is the repository root because the service imports
`shared/protocol.ts`.
