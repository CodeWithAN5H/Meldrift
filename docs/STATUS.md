# Meldrift status

Version: `0.6.0-alpha.1` · Updated: 2026-11-25

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

**M4 — Game streaming**
- Real capture through WebView2's `getDisplayMedia` (Windows Graphics Capture):
  a selected game/application window by default, or an entire display when the
  host explicitly chooses it. Windows' own picker lists real sources; capture
  starts only after the host confirms.
- One video-only `RTCPeerConnection` per viewer, separate from voice, so audio
  negotiation and mute/deafen are untouched. The host always offers; source
  changes use `replaceTrack`, quality changes use `setParameters`, and ordinary
  adjustments never recreate peer connections.
- Server-enforced maximum of four viewers per room, one stream per room, and
  host-only start/stop/preset control. Offer/answer/ICE are relayed only between
  the current host and current viewers, with membership checks, SDP/ICE size
  limits and a per-socket signaling rate limit. Video never passes through the
  signaling service.
- `stream.start/stop/watch/unwatch/preset/sync` and viewer/state events in
  `shared/protocol.ts`; in-memory stream sessions end on host socket close,
  room leave or host disconnect, and a viewer close removes only that viewer.
- Auto/Smooth/Balanced/Quality presets with real capture caps, encoder
  degradation preferences and a stats-driven adaptive controller using loss,
  available outgoing bitrate, RTT, frame rate, dropped frames and
  `qualityLimitationReason`. Limits are 1080p, default 720p30, optional 60 fps.
- Room stage shows the real host preview or the spectator's remote video,
  connection/reconnecting/error states, frame-stall warning, a persistent LIVE
  badge, real resolution/FPS/bitrate/dropped-frame stats, and host controls
  (start, source, preset, change source, stop). Context panel reports host,
  status, capture mode, preset and viewer count; voice dock can start/stop the
  stream and shows Sharing/Watching without hiding voice controls.
- Capture and encoder resources stop on Stop, source close, room leave,
  sign-out, socket loss and app close. No frozen frame is left marked live.

**M5 — Remote control and player handoff**
- Host-approved keyboard and mouse forwarding into a host-selected running
  window, one controller at a time, with a FIFO queue capped at eight requests.
- Dedicated ordered/reliable WebRTC data channel between the approved
  controller and the host, separate from video and voice. The signaling server
  only relays SDP/ICE for the current grant; input never passes through it.
- Rust `SendInput` injection with scan code and virtual key together, relative
  mouse movement, buttons, vertical wheel, held-input tracking and release on
  every teardown path.
- Server authorization: host-only enable/approve/reject/revoke/disable, grant id
  plus 192-bit token delivered only to the two participants, monotonically
  increasing sequence numbers, stale/revoked grant rejection, direction and
  target validation, SDP/ICE size limits and a per-socket signalling rate limit.
- Focus safety: approval arms the chosen window and focuses it; a 400 ms
  watchdog pauses injection and releases held input if focus leaves, and
  disarms on close/minimise. Host can resume the same grant. Emergency stop is
  available in the panel and globally as `Ctrl+Alt+F12`.
- Room stage shows a persistent control badge and a full-surface capture layer
  with pointer lock, `Esc` release, keyboard/mouse forwarding and a live
  round-trip indicator. Context panel and queue tab show host, controller, queue
  and armed window; host and spectator actions are separate.
- Every disconnect/cleanup path ends the grant and releases input: revoke,
  release, handoff, controller or host socket close, stream stop, room leave,
  sign-out, source change, target close/minimise and app exit.
- Gamepad forwarding and multiple simultaneous controllers are **not**
  implemented; see `docs/REMOTE_CONTROL.md`.

**M6 — Reliability and verification**
- Reconnect matrix exercised through the real UI: signaling restart, host and
  viewer disconnect/reconnect, sign-out, app close, stream stop/restart and
  room leave/rejoin. Both clients showed `Reconnecting…`, recovered on their
  own and never left a frozen frame marked live.
- Fixed four defects found during the review, each with a regression test:
  a stale control target after a captured window closed, voice peers surviving
  a roster change across a reconnect, ICE restart being disabled after one
  failed attempt, and endless WebSocket retries against a revoked session
  (now a slow HTTP probe signs out with “Your session expired”).
- Performance profiles for idle, voice-only, stream host, host plus spectator,
  voice plus stream plus spectator and voice plus stream plus control, with
  real video statistics and process-tree CPU/memory.
- A 35-minute soak of a voice + stream + spectator pair and an independent
  voice-only pair, restarting the stream every ten minutes, with zero defects
  detected across 34 samples.
- Installer built for the release version and exercised as an upgrade over the
  previous install; the recording is in `docs/M6_VERIFICATION.md` and the hash
  is below under Distribution.

**Distribution**
- NSIS installer packaged as `artifacts/Meldrift-Setup.exe` for
  `0.6.0-alpha.1`: 1,839,322 bytes, SHA-256
  `9d57c00a5588337b479dbca365784c7cccb6b33225c7941b4836fb09dce622a0`,
  unsigned.
- Installer upgrade verified on this machine: a fresh 0.5.0 install showed
  first-run onboarding, saved a profile and reported `0.5.0-alpha.1` in About;
  running the 0.6.0 installer over it replaced the binary, skipped onboarding on
  next launch, kept the same profile and database, and reported
  `0.6.0-alpha.1`. Uninstall was not exercised in this run.
- Version consistency guard, SHA-256 manifest and build report scripts.
- CI (typecheck, Vitest, Rust tests) and tag-driven release workflow that blocks
  publishing on any failed check; optional Authenticode signing.

## Verified on the development machine (2026-11-24)

Automated:

- `bun run typecheck` — clean.
- `bun run test` — **79 tests passing** across 6 files. M6 adds 5 regression
  tests: control target selection (live id, closed id, captured-title and
  first-visible fallbacks) and voice mesh roster retention plus a repeat ICE
  restart after a failed attempt. The M5 group covers physical key mapping and
  blocked shortcuts, input frame validation, mouse coalescing and key ordering,
  held-input release, grant-token and sequence gating, mouse-only rate limiting
  that still passes key transitions, controller offer/hello/ICE/ack behaviour,
  host answer/activation/ack ordering, channel close, wrong channel labels and
  the injection pump.
- `cd server && bun test` — **45 integration tests passing** against a real
  HTTP + WebSocket server. M5 adds 10 control tests: stream/host/membership
  authorization, FIFO queue with deduplication and cap, approval/handoff with
  immediate revocation of the previous controller, host-only revoke, controller
  release, disconnect/stream-stop/host-close cleanup, signalling direction,
  stale/oversized/flood rejection and replayed grants after handoff.
- `cargo test` — **9 tests passing, 1 ignored** (migrations, invite codes,
  room/message flows, scope rejection, cascade deletes, session round-trip,
  control batch validation) plus the ignored native `SendInput` test.
- `bun run build` — 463 kB JS / 72 kB CSS.
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

### M5 native control run (same PC, three independent release instances)

Three native release clients ran against a fresh signaling database: host
`m5host`, controllers `m5guest` and `m5guest2`, in room `M5 Control`. Each had
its own `MELDRIFT_DATA_DIR` and `WEBVIEW2_USER_DATA_FOLDER`. Sessions were
seeded through the app's own `save_session` IPC; the rest of the run drove the
real UI and browser input through WebView2 DevTools (DOM clicks,
`Input.dispatchKeyEvent`, `Input.dispatchMouseEvent`), so transport and Rust
injection were the production code paths.

- **Stream + control:** host captured the real display (`screen:0:0:live`), with
  one and then two viewers. Remote control was enabled for the harmless
  `Meldrift Input Target — powershell.exe` window, never a game with anti-cheat.
- **Keyboard:** forwarded keys appeared in the target's TextBox; after the guest
  rounds it contained `wwwwwqz` (the host's keyboard layout produced exactly the
  forwarded characters). The controller HUD reported **3 ms** send→inject→ack
  round trip.
- **Mouse:** wheel produced `wheel:120`, left clicks produced
  `mousedown:Left`/`mouseup:Left`, and right clicks produced `mousedown:Right`.
  Pointer lock was granted and forwarded movement moved the host cursor from
  `(968,541)` to `(1268,741)`, exactly the +300/+200 deltas sent.
- **Revoke:** the host revoked while the controller had a button held; the
  controller's surface disappeared and a key sent afterwards did not reach the
  target (its text stayed `wwwww`).
- **Handoff:** the host approved `m5guest2` while `m5guest` held the grant; the
  first grant was revoked, the second controller started, and its `q` reached the
  target (`wwwwwq`).
- **Emergency stop:** `Ctrl+Alt+F12` sent globally turned control off, revoked
  the controller and cleared the armed window.
- **Controller disconnect:** closing the controller app made the host show
  nobody controlling, cleared the armed target and removed its video.
- **Stream stop:** stopping the stream with an active grant disabled remote
  control on both sides while the two clients stayed in voice.
- **Host shutdown:** closing the host ended the stream, revoked the grant and
  cleared control on the remaining client.
- **Voice coexistence:** host and second controller joined voice ("2 in
  channel") while video was live and the second controller was actively
  controlling. The available microphone was NVIDIA Broadcast, so audio content
  was not judged; this checks coexistence and signaling, not audio quality.

**Not verified natively:** two physical PCs on a real network, physical
keyboards/mice (browser-level input events were used), a game with raw-input or
anti-cheat behaviour, target-window close/minimise (covered by the watchdog and
unit tests but not exercised in this run), and CPU use isolated from the game
and browser processes. The target's WinForms TextBox swallowed one right-button
release while its context menu opened; the controller had sent both transitions
and Meldrift releases held buttons on teardown.

### M6 reliability run (2026-11-25)

The full record, including the cross-PC checks that were not run, is in
`docs/M6_VERIFICATION.md`. Automated verification on the changed tree:

- `bun run typecheck` — clean.
- `bun run test` — **79 tests passing** across 6 files.
- `cd server && bun test` — **45 integration tests passing**.
- `cargo test` — **9 tests passing, 1 ignored** (the native `SendInput` test).
- `bun run app:build` / `bun run app:package` — release binary and NSIS
  installer built for `0.6.0-alpha.1`.

Two or three independent release instances ran against one production signaling
service on loopback. Each had its own app-data directory and WebView2 profile
and was driven through WebView2 DevTools with real mouse and key events.

- **Reconnect:** killing and restarting signaling made both clients show
  `Reconnecting…`, reconnect automatically, end the stream without a frozen
  frame or LIVE badge, and rejoin voice with a live remote audio element.
- **Lifecycle:** host close, viewer close, host sign-out and room leave/rejoin
  each cleaned up the other side; a relaunched viewer decoded video again and a
  relaunched host streamed again. Stopping a stream removed every `<video>` and
  the LIVE badge on both sides.
- **Remote-control target:** minimising and then closing the controlled window
  ended the grant, cleared the armed target and told the controller
  (“The game window was minimised.” / “The game window closed.”).
- **Profiles:** idle 0.4%/439 MB host and 0.1%/430 MB viewer; voice-only
  16.7%/505 MB and 14.8%/493 MB; host + spectator 42.8%/625 MB and
  15.8%/526 MB at 1280×720 · 29 fps; voice + stream + spectator 55.9%/639 MB
  and 29.1%/534 MB. The encoder dominated host CPU and Chromium chose software
  encoding.
- **Soak:** a voice + stream + spectator pair and an independent voice-only pair
  ran for **35.4 minutes / 34 samples** with the stream restarted every ten
  minutes. Video was still decoding at the end (1280×720, 8 fps, ~81 kbps),
  one remote audio element was present on each side, both clients stayed
  connected, memory stayed flat (host 608 MB, viewer 537 MB, voice peers
  ~496–502 MB) and zero defects were detected.
- **Limitation:** all clients ran on one PC over loopback with synthetic
  microphone input; two physical machines, real NAT/TURN, physical input devices
  and a Windows 10 clean install were not available. Those checks remain the
  manual checklist in `docs/M6_VERIFICATION.md`.

### M4 native streaming run (same PC, separate WebView2 profiles)

Three native release clients ran against one fresh signaling database:
host `m4host`, spectators `m4guest` and `m4guest2`, signed into distinct
accounts. Two viewers were connected for the multi-spectator measurement.

- **Window capture:** WebView2 returned a real window track labelled
  `window:1051560:0` (Cyberpunk 2077), `displaySurface: window`,
  1280×720 at 30 fps. The host preview played; a 1-second frame sample had
  mean luma 20.4 and frame difference 2.19, proving moving game content, not a
  still image.
- **Spectator playback:** the guest's remote video track was live at
  1280×720, advanced from 6.7 s to 24.8 s, and `getVideoPlaybackQuality()`
  reported 430 frames with 0 dropped. Its overlay showed real
  `1280×720 · 18 fps · 463 kbps`; the host summed both viewers at
  `1280×720 · 17 fps · 958 kbps`.
- **Multiple spectators:** both guest clients watched the same stream; the
  session reported `2/4 watching`, each with live 1280×720 video and roughly
  0.46 Mbps received per viewer.
- **Desktop capture:** after an explicit **Share entire display**, the track was
  `screen:0:0`, `displaySurface: monitor`, 1280×720 at 30 fps, and the UI badge
  said `LIVE · Display`. Spectators decoded 1280×720 at ~29 fps (~0.9 Mbps),
  with frame diff 1.75 and 659 decoded frames / 4 dropped.
- **Voice coexistence:** with the window stream live, both clients joined voice
  using the M3 synthetic-input method (host 440 Hz, guest 660 Hz). The host
  received a 656 Hz peak and the guest 445 Hz, both at RMS ≈0.177, while video
  continued playing. Voice was not interrupted by starting, stopping or
  restarting video.
- **Stop/restart and source switch:** Stop removed every `<video>` element on
  both sides while voice stayed connected; restart brought video back. Changing
  source kept the existing viewer connection alive, replaced the track and
  resumed moving frames (frame diff 50.2 after the switch).
- **Leave/rejoin:** a spectator left the stream (0 videos, still in voice and
  room) and re-watched successfully.
- **Disconnect and app close:** killing signaling stopped host capture with a
  clear message and removed spectator video; the host auto-reconnected when the
  service returned. In a clean sign-in run a spectator also auto-reconnected
  and showed no video because the stream had ended. Closing the host app during
  an active stream removed the spectator video. No frozen frame remained in any
  of these cases.
- **Resources with two viewers and a 1280×720 desktop stream:** host ~4.9% CPU
  (all 16 hardware threads) and ~621 MB RSS across its WebView2 process tree;
  each spectator ~1.8–2.0% CPU and ~481–486 MB RSS; GPU engine counters ~1.6%
  host and ~0.8% spectator. The encoder was software (`libvpx`) on this run,
  which explains the modest frame rates; the browser is free to pick a hardware
  encoder when available.

**Not verified natively:** two physical PCs (or a real network with TURN);
closing the captured game window while it is the active source (the user's game
was left running); a host explicitly leaving the room or signing out mid-stream
(code paths implemented and unit-covered, but not exercised in this run);
multiple simultaneous voice peers plus video beyond two clients; and human
visual/audio judgement. The three native processes shared one Tauri app-data
SQLite file (Tauri's known-folder path ignores `APPDATA`), although each had a
separate WebView2 profile and a distinct account. This caused local session
interference between test clients, so it is not equivalent to the required
separate app-data directories or two machines.

## In progress

- Nothing. M6 is complete. Gamepad forwarding, multiple simultaneous
  controllers, TURN deployment and two-machine verification remain future work
  and are not presented as available.

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
  `Reconnecting…` until peers are actually connected. Account settings exposes a
  manual Reconnect if the socket remains down.
- **Streaming is a host→viewer mesh capped at four viewers.** The host uploads
  one encoded video stream per viewer (~3–8 Mbps each depending on preset), so
  four viewers can mean 12–32 Mbps upstream. TURN relaying roughly doubles the
  operator's bandwidth per viewer. An SFU is required beyond this shape and is
  not built.
- **No game/system audio capture.** M4 streams video; voice remains the audio
  channel. Adding game audio would need an explicit capture path and mix.
- **The capture picker is WebView2/Windows'**, not a custom Meldrift source list.
  Protected content, some exclusive-fullscreen games and DRM surfaces cannot be
  captured and are reported, not bypassed. Minimised windows may stop producing
  frames; the UI shows a waiting-for-frames warning.
- **Video uses the browser's codec choice.** No codec is forced and no hardware
  encoder is assumed; the actual encoder/codec comes from WebRTC statistics.
- **Host disconnect/server restart ends the stream by design.** There is no
  media-server failover; the host must start a new stream after reconnecting.
- **No native two-machine verification.** All native clients ran on one PC with
  one GPU and virtual microphones; the synthetic-voice and shared-app-data
  limitations above still apply.
- **Remote control injects at the OS foreground**, not inside the chosen
  window. `SendInput` targets whatever is foreground; Meldrift arms the selected
  window and pauses/releases input when focus leaves, but a brief race or another
  process stealing focus is possible. Elevated games need Meldrift at the same
  integrity level (UIPI), and games with kernel anti-cheat may ignore or flag
  synthetic input. This is documented, not bypassed.
- **One remote controller at a time.** The queue is capped at eight; multiple
  simultaneous controllers are not implemented.
- **Gamepads are not forwarded.** A reliable path needs a virtual gamepad driver
  installed with administrator rights; M5 does not install one.
- **Pointer lock and `Esc`:** releasing control with `Esc` also delivers that
  key-down to the game (usually opening its pause menu).
- **Native control verification used browser-level input events and one PC.**
  The full transport and real `SendInput` were exercised, but not physical
  keyboards on two machines, and remote control has only been measured on a
  loopback LAN path.
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

1. **Two-machine verification**: the manual checklist in `docs/M6_VERIFICATION.md`
   (register/friend/chat, real microphone and speakers, physical keyboard and
   mouse through remote control, host network loss, sign-out and app close on a
   real LAN, then STUN-only internet and a TURN relay).
2. **M5 follow-ups**: elevated-game and raw-input compatibility matrix, a native
   synthetic-keyboard delivery re-run, virtual-gamepad driver design (needs
   explicit approval).
3. **M4 follow-ups**: captured-window-close test, hardware-encoder measurement,
   optional SFU experiment for more than four viewers.
4. **M3 follow-ups**: per-participant volume, TURN deployment guide validation
   against coturn.
5. **M7**: signed releases on GitHub Releases.
