# Signaling server deployment

Meldrift has two explicit deployment modes. There is no third mode and no silent
fallback between them.

| Mode | Server | Who can join | Needs internet |
| --- | --- | --- | --- |
| **Local** (default) | Bundled sidecar started and supervised by the desktop app on `127.0.0.1` | Only this PC | No |
| **Remote** | A Bun/Docker service you host at an `https://` address | Everyone pointed at the same server | Yes, for cross-PC play |

## Local mode

The installer contains `meldrift-server.exe`, the existing Bun signaling
service compiled as a standalone executable and declared as a Tauri
[`externalBin` sidecar](https://v2.tauri.app/develop/sidecar/).

The Rust core (`src-tauri/src/signaling.rs`) owns the process:

1. **Port selection.** It probes `127.0.0.1:8787–8796`. A port already answering
   the Meldrift health endpoint is reused (for example from a second app
   instance); any other listener is skipped. A free port is taken before spawn.
2. **Startup.** It spawns the sidecar with:
   - `MELDRIFT_HOST=127.0.0.1` (loopback only, never `0.0.0.0`)
   - `MELDRIFT_PORT=<chosen port>`
   - `MELDRIFT_DATA=<app data>/server/meldrift.db`
   - `MELDRIFT_VERSION=<app version>`
3. **Readiness.** Account controls stay disabled until `GET /api/health`
   returns `200` with `name: "meldrift-signaling"`. A start that does not become
   ready within 12 seconds is killed and reported as failed with the log path.
4. **Crash handling.** Unexpected exits are recorded and the sidecar is
   restarted up to three times with a short backoff. A repeated failure is shown
   in Settings with the last server log lines.
5. **Shutdown.** Closing Meldrift, or choosing Remote mode, kills the sidecar and
   its process group. If the shell is force-killed, the sidecar checks its parent
   PID once a second and exits on its own, so no server process is left behind.

### Data and logs

| Item | Windows path |
| --- | --- |
| Server database | `%APPDATA%\com.meldrift.desktop\server\meldrift.db` (+ `-wal`) |
| Server log | `%APPDATA%\com.meldrift.desktop\logs\signaling.log` |
| App/startup log | `%APPDATA%\com.meldrift.desktop\meldrift-startup.log` |

`MELDRIFT_DATA_DIR` overrides the app data directory for isolated test clients.
Upgrading or reinstalling the app does not touch the server database, so local
accounts, rooms, friends and messages survive.

### Offline

Local mode never contacts the internet for account, room, friend or chat
features. Voice and streaming are peer-to-peer over the local machine/network;
STUN defaults are harmless when offline, and external TURN is optional.

### Why the old build showed `127.0.0.1:8787` but nothing listened

The `0.6.0-alpha.2` installer contained no signaling server and launched no
process. Settings merely prefilled `http://127.0.0.1:8787`, so the address was a
guess, not a service. `Test-NetConnection` correctly reported the port closed.
This build ships the server, starts it, and only offers account controls after a
real health check.

## Remote mode

Choose **Settings → Account → Mode → Remote server**, enter the same address on
every PC, and use **Test connection**. Remote mode stops the local sidecar and
never falls back to localhost.

### Run the service

Directly with Bun:

```bash
cd server
bun install
MELDRIFT_HOST=0.0.0.0 \
MELDRIFT_PORT=8787 \
MELDRIFT_DATA=/var/lib/meldrift/meldrift.db \
MELDRIFT_TRUST_PROXY=1 \
bun run start
```

Or with Docker (from the repository root):

```bash
docker build -f server/Dockerfile -t meldrift-server .
docker run -d --name meldrift \
  -p 127.0.0.1:8787:8787 \
  -v meldrift-data:/data \
  --restart unless-stopped \
  meldrift-server
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `MELDRIFT_HOST` | remote: `0.0.0.0` behind a proxy | Bind address. Never expose it directly without TLS. |
| `MELDRIFT_PORT` | no (8787) | HTTP/WebSocket port. |
| `MELDRIFT_DATA` | yes in production | SQLite file; keep it on a persistent volume. |
| `MELDRIFT_TRUST_PROXY` | behind a proxy | `1` makes rate limiting use `X-Forwarded-For`. |
| `MELDRIFT_STUN_URLS` | no | Comma-separated STUN URLs. |
| `MELDRIFT_TURN_URLS` | for strict NATs | Comma-separated TURN/TURNS URLs. |
| `MELDRIFT_TURN_USERNAME` / `MELDRIFT_TURN_CREDENTIAL` | with TURN | Credentials returned only to signed-in clients. |

### TLS and reverse proxy

Terminate HTTPS/WSS at Caddy, nginx or Cloudflare Tunnel. The desktop client
uses `wss://` automatically for an `https://` server URL. A minimal Caddyfile:

```caddyfile
voice.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

nginx must forward WebSocket upgrades:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 90s;
}
```

Expose **443/tcp** publicly; keep 8787 bound to loopback. If you terminate TLS
elsewhere, also allow the proxy's connection to 8787. The service does not
terminate TLS itself and has no admin endpoints to expose.

The desktop app rejects plain `http://` for public hostnames. Plain http is
accepted only for loopback and private LAN addresses (`10/8`, `172.16/12`,
`192.168/16`), so a test server on your LAN still works.

### Persistence, backup and security

- Back up `meldrift.db` **and** its `-wal` file, or stop the service first.
- Keep the database and logs off any public path; the service only serves
  `/api/*` and `/ws`.
- Accounts use argon2id hashes and opaque 256-bit bearer tokens; keep the server
  behind TLS. Rate limits and room/friend authorization are unchanged by mode.
- Do not enable `MELDRIFT_TRUST_PROXY` unless a proxy you control sets
  `X-Forwarded-For`; otherwise clients can spoof their address.
- All PCs must use the **same** server URL, otherwise they have separate
  accounts and cannot see each other's rooms.

### Voice and streaming

Signaling is small; voice and video are peer-to-peer. STUN is enough for many
home networks. Symmetric NATs need a TURN relay such as coturn:

```bash
MELDRIFT_TURN_URLS="turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349" \
MELDRIFT_TURN_USERNAME="meldrift" \
MELDRIFT_TURN_CREDENTIAL="change-me" \
bun run start
```

Open UDP/TCP 3478, TCP 5349 and the coturn relay range (for example UDP
49160–49200). **TURN relays media and consumes bandwidth**; size the relay and
its monthly transfer budget before inviting a large group. See `docs/VOICE.md`.

## Verification commands

```bash
bun run server:build             # compile the sidecar
bun run server:test:packaged     # health, restart persistence, port conflict, shutdown
cd server && bun test            # full HTTP/WebSocket suite
bun run typecheck && bun run test
cargo test --manifest-path src-tauri/Cargo.toml
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Local server failed | Settings shows the log path; read `logs/signaling.log`. |
| Local server stuck starting | Another process may own all ports 8787–8796; close it. |
| Remote test fails | URL, DNS, firewall 443, proxy WebSocket upgrade, certificate chain. |
| Signed in but no peers | Both PCs must use the same server and be friends or room mates. |
| Voice connects but no audio | Check TURN configuration and UDP relay ports. |
| `https://` rejected | The certificate must be valid; self-signed certs are not trusted by WebView2. |
