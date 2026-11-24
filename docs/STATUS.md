# Meldrift status

Version: `0.3.0-alpha.1` · Updated: 2026-11-24

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

**M3 — Real-time voice**
- Real WebRTC/Opus voice between signed-in clients, peer-to-peer mesh, eight
  participants maximum (enforced by the server).
- Voice join/leave bound to room membership, with the server rejecting
  signaling for non-members and for people not in the channel.
- `voice.join`, `voice.leave`, `voice.state`, `voice.offer`, `voice.answer`,
  `voice.ice` on the existing authenticated WebSocket; roster and participant
  state events in the other direction.
- SDP/candidate size validation, a per-socket signaling rate limit and a hard
  participant cap; voice membership is dropped on socket close and when a user
  switches rooms.
- Capture uses the real microphone with echo cancellation, noise suppression,
  automatic gain control and the persisted input-volume gain; the same processed
  stream is sent to peers.
- Mute/unmute, deafen/undeafen, push-to-talk (window focus), microphone input
  meter, microphone and output device selection, hot-plug handling, permission
  denial and microphone removal handled without fake state.
- Speaking indicators are driven by the local processed signal and by an
  analyser on each received stream; connection states come from real
  `RTCPeerConnection.connectionState` values.
- ICE server configuration comes from the server (`GET /api/voice/ice`,
  authenticated) with optional per-device overrides in Settings → Audio.
- ICE restart on failure, signaling reconnect with capped exponential backoff
  and jitter, voice rejoin after reconnect, and complete cleanup on leave,
  room switch, sign-out and app close.
- No duplicate peers or captures across repeated join/leave/rejoin.

**Distribution**
- NSIS installer packaged as `artifacts/Meldrift-Setup.exe`.
- Version consistency guard, SHA-256 manifest and build report scripts.
- CI (typecheck, Vitest, Rust tests) and tag-driven release workflow that blocks
  publishing on any failed check; optional Authenticode signing.

## Verified on the development machine (2026-11-24)

Automated:

- `bun run typecheck` — clean.
- `bun run test` — **37 tests passing** across 4 files (model, persistence
  contract, networking, voice mesh/ICE/speaking logic).
- `cd server && bun test` — **25 integration tests passing** against a real
  HTTP + WebSocket server. Fifteen of them are voice: ICE config auth,
  non-member and unknown-room rejection, join/duplicate rejoin, offer/answer/ICE
  routing, non-voice and self targets, malformed and oversized payloads, rate
  limiting, state broadcast, leave and socket-close cleanup, room switch, and
  the eight-participant cap.
- `cargo test` — **8 tests passing** (migrations, invite codes, room/message
  flows, scope rejection, cascade deletes, session round-trip).
- `bun run build` — 390 kB JS / 65 kB CSS.
- `bun run app:build` — release `meldrift.exe` and NSIS installer built
  successfully.

Native two-client run (same PC, two independent release instances, separate
WebView2 profiles and app-data folders, one fresh signaling database):

- Both accounts signed in; both joined the same room and the same voice channel.
- Real capture opened on both clients. The machine only exposes virtual
  microphones (WO Mic, NVIDIA Broadcast) and neither produced input, so the real
  microphone path carried silence (`totalAudioEnergy` ≈ 1e-8).
- To verify actual decoded audio rather than a connection flag, each client's
  `getUserMedia` was replaced with a synthetic oscillator (A = 440 Hz,
  B = 660 Hz) while everything else — capture graph, gain, mute, Opus, ICE,
  peer connections, audio elements — stayed the app's real code.
- Measured on the receiving remote track: **A received 662 Hz, B received
  439 Hz**, with audio energy rising ~0.028 per 1.2 s on both sides. Bidirectional
  audio was therefore decoded and audible-ready at both endpoints.
- Mute disabled the mic and outbound tracks: the peer's inbound energy fell to
  2.5e-8 and its speaking indicator went false. Unmute restored energy (0.0358,
  level 0.15) and the indicator.
- Deafen set the remote `<audio>` element to muted while inbound RTP continued;
  undeafen restored it.
- Remote speaking indicators tracked the actual received level on both clients.
- Leaving voice closed the peer and removed the participant on the other client;
  rejoining produced exactly one live peer connection per side, two participants
  and audio again.
- Signaling was killed and restarted: both clients showed `Reconnecting…`, then
  reconnected, rejoined voice and resumed bidirectional audio (662/439 Hz).
  Re-establishing ICE took roughly 10 seconds on this machine.
- Connection stats while connected: 475 packets each way, ~1 ms selected-pair
  RTT, 0–1 ms jitter.

**Not verified:** real microphone → speaker audio between two physical machines,
and human listening. That requires a second PC with a working physical
microphone; see the limitations below.

## In progress

- Nothing. M3 is complete; M4 game streaming has not started.

## Known bugs

- None confirmed in the voice paths above. The tests caught and fixed an earlier
  rejoin case where a stale peer could suppress the new offer; the current mesh
  closes previous peers on a rejoin acknowledgement and always has the later
  joiner offer.
- Manual Windows testing is limited to this development machine; the installer
  has not been run on a clean Windows 10 image.

## Technical limitations (honest)

- **Voice is a mesh, capped at eight people.** Each participant encodes one Opus
  stream per peer. Eight people means seven upstream streams (~340 kbps up).
  Larger calls need an SFU, which is not built.
- **TURN is not included.** The service ships a public STUN default and optional
  TURN settings. Two peers behind strict/symmetric NATs will not connect without
  a TURN server; no claim is made that P2P works on every network. Hosting TURN
  is the operator's bandwidth cost (documented in `docs/VOICE.md`).
- **The bidirectional audio test used synthetic input**, clearly distinguished
  from a real microphone. Real capture was exercised but the available
  microphones were virtual and silent. Both clients ran on one physical machine
  as independent native processes; two physical machines were not available.
- **Speaking indicators use thresholds and hysteresis**, not a speech model.
  Loud fans or music can light them; very quiet speech may not. The remote
  indicator measures received audio, so deafening does not hide who is speaking.
- **Push-to-talk needs window focus.** A global keyboard hook is M5 work.
- **No per-participant volume**, no noise gate beyond the WebView2 noise
  suppression toggle, no manual Opus complexity/FEC controls, no recording.
- **Microphone permission** is WebView2's own prompt, shown on the first join.
  Denying it leaves voice unjoined with a real error; there is no custom
  pre-prompt.
- **Output device selection** depends on `HTMLAudioElement.setSinkId` in
  WebView2; where it is unavailable the system default is used.
- **Reconnect is automatic with no manual retry button.** Media can take several
  seconds to re-establish after a signaling restart; the dock says
  `Reconnecting…` until peers are actually connected.
- **Streaming is absent.** The stage is an empty state; capture controls are
  disabled with explicit reasons.
- **Remote control is absent.** The permission model is documented, not built.
- **Server rooms cannot be renamed, deleted or left** in this build. Local rooms
  can.
- **Presence** is online/idle/offline with no inactivity timer.
- **Delivery is live-only.** Messages sent while both people are offline are
  stored and appear when the conversation is opened next.
- **Session tokens** are stored plaintext in local SQLite; DPAPI wrapping is
  planned before beta.
- **CSP** allows `http:`/`https:`/`ws:`/`wss:` connections for self-hosted
  servers; scripts remain restricted to `'self'`.
- **Installer is unsigned** unless a certificate is configured.
- **Accessibility** covers focus, labels and reduced motion, but has not been
  audited with a screen reader.
- **Idle resource numbers** are not profiled; nothing is claimed.

## Next steps

1. **M3 follow-ups**: two-machine physical-mic test, per-participant volume,
   TURN deployment guide validation against coturn, optional SFU experiment.
2. **M4**: Windows graphics capture → H.264 → WebRTC video, adaptive bitrate.
3. **M5**: input forwarding behind host grants, queue, handoff, emergency stop.
4. **M6**: profiling, soak tests, reconnect matrix, installer upgrade tests.
5. **M7**: signed releases on GitHub Releases.
