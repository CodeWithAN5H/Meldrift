# Meldrift

**Your game. Everyone's turn.**

A free Windows desktop app where friends gather in rooms, talk over voice, watch a
host's game live and take turns controlling it. No subscriptions, no ads, no
premium tier.

> **Status: `0.4.0-alpha.1`** — the permanent interface, the local workspace, the
> self-hostable networking service, **real WebRTC voice** and **live game/window
> streaming** between signed-in clients are working. Remote control (M5) is not
> built; anything absent is visibly marked as such in the app.

---

## What works today

| Area | State |
| --- | --- |
| Windows desktop shell (Tauri 2 + WebView2) | Working: frameless window, custom chrome, resize, fullscreen |
| Permanent UI (rail, sidebar, workspace, context panel, voice dock) | Working |
| Local workspace: profile, rooms, room chat, DMs, friends, game library | Working, persisted in SQLite |
| Settings (audio devices, PTT, stream prefs, appearance, data) | Working, persisted |
| Accounts, rooms, chat, DMs, friends, presence across PCs | Working when signed in to a self-hosted signaling server (M2) |
| Room voice (M3) | Working WebRTC/Opus mesh for up to 8 people: real capture, mute/deafen, push-to-talk, mic and output selection, input meter, real speaking and connection states, ICE restart and signaling reconnection |
| Game/window streaming (M4) | Working real capture through WebView2 + Windows Graphics Capture, live WebRTC video to up to 4 viewers, window or entire-display source, adaptive Auto/Smooth/Balanced/Quality presets, real encoder/viewer stats, voice unaffected |
| Remote input and control handoff | **Not built** (M5) |
| Signed installer + releases | NSIS packaging and CI ready; signing needs a certificate |

Meldrift does not show fake peers, fake latency or a fake "connected" state. A
voice participant is only shown as connected when their actual WebRTC peer
connection reports `connected`, and a speaking ring only lights when received
audio (or the local processed microphone signal) is above the speech threshold.
Streaming shows the real captured surface, encoder resolution, frame rate,
bitrate and dropped frames from WebRTC statistics; if frames stop, it says so
instead of leaving a frozen picture marked live.

## Requirements

- Windows 10/11 64-bit
- [Bun](https://bun.sh) 1.2+
- Rust (stable, MSVC toolchain) + Visual Studio 2022 C++ build tools
- WebView2 runtime (preinstalled on Windows 11; the installer bootstraps it on 10)

## Run it

```bash
bun install
bun run app:dev      # full desktop app with hot reload
```

Frontend-only loop (no Rust rebuild, data in localStorage):

```bash
bun run dev          # http://127.0.0.1:1420
```

## Run the signaling server (optional)

Rooms, chat and voice need the signaling service, which you run yourself — one
Bun process, one SQLite file:

```bash
cd server && bun install && bun run start   # http://127.0.0.1:8787
```

Then open **Settings → Account**, enter the server address and create an account
on each PC. Use `https://` when the server is reachable from the internet.

Voice is peer-to-peer audio, but peers still need a before-first-word path:
the service serves STUN defaults and optional TURN credentials to signed-in
clients. Add TURN when participants may be behind strict NATs:

```bash
MELDRIFT_TURN_URLS="turn:turn.example.com:3478?transport=udp" \
MELDRIFT_TURN_USERNAME="meldrift" \
MELDRIFT_TURN_CREDENTIAL="change-me" \
bun run start
```

See `docs/VOICE.md` for coturn, ports, bandwidth and cost, and
`docs/NETWORKING.md` / `server/README.md` for the service.

## Streaming

In a room, the host chooses **Share game window** or **Share entire display**.
Windows' own picker selects the real surface; capture never starts before that
explicit choice. Video is sent peer-to-peer on one video-only WebRTC connection
per viewer, while voice keeps its separate connections. Up to **four viewers**
are allowed because the host uploads one encoded stream per viewer (roughly
3–8 Mbps each at the presets); larger audiences need an SFU, which is not part
of M4.

Quality presets are real: Auto adapts bitrate and resolution to loss, available
bitrate and RTT; Smooth protects frame rate; Quality protects resolution.
See `docs/STREAMING.md` for capture architecture, codecs, bandwidth, WebView2
limits and troubleshooting. Native verification results are in `docs/STATUS.md`.

## Build the installer

```bash
bun run app:package
```

Output: `artifacts/Meldrift-Setup.exe` (unsigned unless signing is configured —
see `docs/RELEASING.md`).

## Tests

```bash
bun run typecheck
bun run test                              # Vitest: model, persistence, networking, voice logic
cd server && bun test                     # real HTTP + WebSocket integration tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Documentation

- `docs/ARCHITECTURE.md` — modules, data flow, performance and security decisions
- `docs/NETWORKING.md` — signaling service, wire protocol, client behaviour, limits
- `docs/VOICE.md` — voice architecture, signaling flow, STUN/TURN, ports, costs, limits
- `docs/STATUS.md` — completed work, known bugs, measured results, next steps
- `docs/RELEASING.md` — versioning, installer, signing and GitHub Releases

## Licence

Source is provided for the Meldrift project. Bundled dependencies keep their own
licences (Tauri, React, SQLite, Lucide).
