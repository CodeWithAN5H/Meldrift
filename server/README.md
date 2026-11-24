# Meldrift signaling service

The service that makes rooms, presence, friends and chat work between PCs. It is
a single Bun binary with one SQLite file, designed to be self-hosted.

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

## What it does

- Accounts with argon2id password hashes and opaque 256-bit session tokens.
- Rooms with 7-character invite codes; joining is by code.
- Room chat and direct messages, persisted in SQLite.
- Friend requests, accept/remove, and presence for friends and people who share
  a room. Nobody else can see you.
- A WebSocket at `/ws?token=…` for fan-out, acknowledgements and heartbeats.

## What it does not do yet

Voice and video (M3), game streaming (M4), remote control (M5), room deletion or
leaving a room, and file uploads. Message delivery is live-only: if both people
are offline, the message is stored but pushed to nobody until they reconnect and
open the conversation.

## Tests

```
bun test
```

The suite starts a real HTTP + WebSocket server against an in-memory database and
covers registration, login, duplicate usernames, room creation and joining,
fan-out, membership enforcement, DMs, friend requests and presence transitions.

## Self-hosting notes

- Put this behind HTTPS (Caddy, nginx, Cloudflare Tunnel) before exposing it.
  Session tokens are bearer credentials and the desktop client uses `wss://`
  automatically when the server URL is `https://`.
- `MELDRIFT_HOST=0.0.0.0` requires a firewall and TLS in front; the service
  itself does not terminate TLS.
- SQLite is enough for a friend group. There is no federation or sharding.
- Back up `meldrift.db` (plus its `-wal` file) if the messages matter.

## Docker

```
docker build -f server/Dockerfile -t meldrift-server .
docker run -p 8787:8787 -v meldrift-data:/data meldrift-server
```

The build context is the repository root because the service imports
`shared/protocol.ts`.
