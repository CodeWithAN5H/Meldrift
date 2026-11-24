# Meldrift status

Version: `0.2.0-alpha.1` · Updated: 2026-11-24

## Completed

**M0 — Foundation**
- Tauri 2 shell, Rust core, Vite/React/TS build.
- SQLite storage with migrations, WAL, validation and cascade deletes.
- Window lifecycle (frameless, hidden until paint, custom caption buttons).
- Typed IPC layer with a documented desktop/preview duality.

**M1 — Permanent UI**
- Design system: tokens, typography, spacing, radii, motion, reduced-motion.
- Left rail, room sidebar, adaptive workspace, right context panel, voice dock.
- Screens: Home, Friends + DMs, Rooms, Room workspace, Games, Settings,
  Onboarding, command palette, modals, toasts.
- Real microphone capture with live metering, mute/deafen, push-to-talk.
- Persisted rooms, chat, DMs, friends, game library, profile and settings.

**M2 — Networking foundation**
- Self-hostable signaling service (`server/`): Bun + SQLite, single binary.
- Accounts (argon2id, opaque session tokens), rate-limited auth.
- Rooms with invite codes, join by code, live member lists.
- Room chat and friend-only DMs over a WebSocket with acknowledgements and
  heartbeats; history persisted server-side.
- Friend requests, accept/decline, removal, and presence limited to friends and
  room mates.
- Desktop client: Account settings, connection status, reconnecting channel,
  network-aware workspace actions, live member panel, request UI.
- Session persisted in local SQLite so sign-in survives a restart; sign-out
  restores the local workspace untouched.
- Protocol shared by both sides in `shared/protocol.ts`.

**Distribution**
- NSIS installer packaged as `artifacts/Meldrift-Setup.exe`.
- Version consistency guard, SHA-256 manifest and build report scripts.
- CI (typecheck, Vitest, Rust tests) and tag-driven release workflow that blocks
  publishing on any failed check; optional Authenticode signing.

## Verified on the development machine (2026-11-24)

- `bun run typecheck` — clean.
- `bun run test` — **24 tests passing** (model, persistence contract, server
  address normalisation, socket URL, message merging, wire mapping).
- `cd server && bun test` — **10 integration tests passing** against a real
  HTTP + WebSocket server (auth, duplicates, rate limit, rooms, join, fan-out,
  non-member rejection, DMs, friendship gate, presence transitions).
- `cargo test` — **8 tests passing** (migrations, invite codes, room/message
  flows, scope rejection, cascade deletes, session round-trip).
- `bun run build` — 367 kB JS / 64 kB CSS.
- Two-client end-to-end in the browser: registration, room creation, join by
  code, two-member list, room message delivery, friend request + accept,
  mutual online presence, DM delivery, sign-out restoring local data.

## In progress

- M3 design: WebRTC voice. No audio transport exists yet.

## Known bugs

- None confirmed in the networking paths above. The two-client run caught and
  fixed a load-order race where local data could overwrite server rooms after a
  reload; `init()` now yields to an active server session.
- Manual Windows testing is limited to the development machine; the installer
  has not been run on a clean Windows 10 image, and the native Tauri window has
  not been driven end-to-end by an automated harness.

## Technical limitations (honest)

- **Voice is absent.** Microphone capture and metering are real and local; no
  audio is transmitted. UI says so.
- **Streaming is absent.** The stage is an empty state; capture controls are
  disabled with explicit reasons.
- **Remote control is absent.** The permission model is documented, not built.
- **Server rooms cannot be renamed, deleted or left** in this build. Local rooms
  can.
- **Presence** is online/idle/offline with no inactivity timer; it is live-only,
  not historical.
- **Delivery is live-only.** Messages sent while both people are offline are
  stored on the server and appear when the conversation is opened next.
- **Session tokens** are stored plaintext in local SQLite; DPAPI wrapping is
  planned before beta.
- **CSP** allows `http:`/`https:`/`ws:`/`wss:` connections for self-hosted
  servers; scripts remain restricted to `'self'`.
- **Push-to-talk** requires window focus; a global keyboard hook is M5 work.
- **Output device selection** is stored but not applied (no playback path yet).
- **Installer is unsigned** unless a certificate is configured.
- **Accessibility** covers focus, labels and reduced motion, but has not been
  audited with a screen reader.
- **Idle resource numbers** are not measured; nothing is claimed.

## Next steps

1. **M2 follow-ups**: leave/rename/delete server rooms, offline message push,
   unread counts, session revocation from the account panel.
2. **M3**: WebRTC voice — peer mesh for small rooms, Opus, jitter stats,
   reconnection, per-member volume.
3. **M4**: Windows graphics capture → H.264 → WebRTC video, adaptive bitrate.
4. **M5**: input forwarding behind host grants, queue, handoff, emergency stop.
5. **M6**: profiling, soak tests, reconnect matrix, installer upgrade tests.
6. **M7**: signed releases on GitHub Releases.
