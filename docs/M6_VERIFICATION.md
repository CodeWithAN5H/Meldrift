# M6 verification record

Version: `0.6.0-alpha.1` · Recorded 2026-11-25

This is the evidence behind the M6 reliability milestone. Results are classified
as **Verified**, **Implemented but not verified**, **Not verified** or
**Known limitation**. Nothing here is inferred from a green connection light:
the checks read real video frames, audio elements, media state and the native
Windows target.

## Environment

- Windows 11 Pro 10.0.26200, Intel Core i5-14400F (10 cores / 16 logical
  processors), 16 GB RAM, NVIDIA GeForce RTX 3060 (driver 32.0.16.2101),
  1920×1080 display.
- WebView2 158.0.4370.33.
- Production release executable built with `bun run app:build`; production
  signaling service (`server/src/index.ts`, Bun + SQLite) on `127.0.0.1:8787`
  with a fresh database.
- Each client used its own `MELDRIFT_DATA_DIR` and
  `WEBVIEW2_USER_DATA_FOLDER`. Clients were driven through WebView2 DevTools
  with real mouse events; capture used the real Windows source picker path
  (auto-selected to the entire display).
- The machine has no working physical microphone (only WO Mic and NVIDIA
  Broadcast endpoints, both silent). Voice tests therefore replaced
  `getUserMedia` with a synthetic oscillator **after** the real capture path,
  exactly as in M3–M5. Audio transport, Opus, ICE, mute and peer teardown were
  the production code paths; microphone hardware was not.
- No second physical Windows PC and no real internet/NAT environment were
  available. All clients ran on one machine over loopback.

## Cross-PC and real network — Not verified

| Check | Result |
| --- | --- |
| Two physical Windows PCs, LAN | **Not verified** — no second PC available |
| Internet/NAT traversal, STUN-only | **Not verified** |
| TURN relay / restrictive or symmetric NAT | **Not verified** — no TURN server configured |
| Physical microphone → speaker, both directions | **Not verified** — no working physical microphone |
| Physical keyboards/mice through control | **Not verified** — CDP input events and real `SendInput` were exercised; not physical devices on two machines |
| Windows 10 clean environment | **Not verified** — Windows 11 only |

The loopback results below prove the product's own code paths, not a real
two-machine deployment. TURN and restrictive-NAT connectivity must not be
claimed from this record.

## Reconnect and lifecycle matrix

Two or three independent release clients ran against one signaling service.
Unless stated otherwise, every row was observed through the real UI.

| Case | Result | Evidence |
| --- | --- | --- |
| Signaling server restart | **Verified** | Both clients showed `Reconnecting…`, reconnected automatically, the stream ended with no frozen frame or LIVE badge, and both rejoined voice with a live remote audio element. |
| Temporary network loss/recovery | **Not verified separately** | Server termination is the socket-loss proxy used here; no NIC/firewall manipulation was performed. |
| Host disconnect/reconnect | **Verified** | Closing the host app ended the stream and removed viewer video; signing out mid-stream did the same; a relaunched host streamed again. |
| Viewer disconnect/reconnect | **Verified** | Closing the viewer removed it from the host (`0/4 watching`); a fresh instance rejoined, watched and decoded video again. |
| Voice peer failure / ICE restart | **Implemented but not verified** | ICE-restart offers and retry-after-failure are unit-covered; no real ICE failure was forced in this run. |
| Stream stop and restart | **Verified** | Stop removed every `<video>` and the LIVE badge on both sides; restart re-decoded video. The frozen-frame assertion returned no video elements. |
| Room leave and rejoin (viewer) | **Verified** | Leaving the room and re-entering cleared the viewer's video rather than keeping a stale frame. |
| Voice leave/rejoin | **Verified in M5; not repeated in M6** | M5 measured exactly one peer per side after leave/rejoin; the M6 restart case also re-established audio peers. |
| Sign-out during voice and streaming | **Verified** | Host sign-out stopped capture and voice, and the viewer's video and LIVE state disappeared. |
| Sign-out during remote control | **Implemented but not verified natively** | Cleanup runs through the same revoke/end path as the verified target cases and Rust tests. |
| App close during active sessions | **Verified** | Host close ended the stream for the viewer; viewer close removed only that viewer. |
| Captured window close/minimise | **Not verified** | Only entire-display capture was exercised. The waiting-for-frames overlay exists, but a window source was not closed during M6. |
| Remote-control target close | **Verified** | Host showed “The game window closed.”, armed target and grant cleared, controller notified. |
| Remote-control target minimise | **Verified** | Host showed “The game window was minimised.”, control ended and nothing stayed armed. |
| Controller disconnect while holding input | **Implemented but not verified natively in M6** | Controller close ended control and left nothing armed. Held-key release is covered by Rust/unit tests and was verified natively in M5; the M6 synthetic key delivery did not reach the target, so it is not claimed here. |
| Host revoke / emergency stop during input | **Verified in M5; revocation re-verified in M6** | M5 revoked while a button was held. M6 verified revocation on target close/minimise; the global emergency hotkey was not repeated. |

## Performance profiling

Measured on the hardware above, release build, one host and one viewer on
loopback, 1280×720 entire-display capture, Auto preset, synthetic microphone.
CPU is the sum of the app plus its WebView2 child processes as a percentage of
all 16 logical processors, sampled over 20–30 seconds. Memory is working set.
GPU engine counters are system-wide and were not isolated per process.

| State | Host CPU | Host memory | Viewer CPU | Viewer memory | Video |
| --- | --- | --- | --- | --- | --- |
| Idle, both signed in | 0.4% | 439 MB | 0.1% | 430 MB | — |
| Voice only (two peers) | 16.7% | 505 MB | 14.8% | 493 MB | — |
| Stream host, no viewer | 30.6% | 581 MB | — | — | capture active |
| Stream host + spectator | 42.8% | 625 MB | 15.8% | 526 MB | 1280×720 · 29 fps · ~305 kbps each |
| Voice + stream + spectator | 55.9% | 639 MB | 29.1% | 534 MB | 1280×720 · 29 fps · ~200 kbps each |
| Voice + stream + control | 34.9% | 624 MB | — | — | 1280×720 · 29 fps · ~290 kbps |

Observations:

- Idle cost is low and stable; the app does not poll or animate in the
  background.
- The encoder dominates host CPU. Chromium chose software encoding on this run,
  so 29 fps at 720p is expected to cost roughly 1.5–2 cores; a hardware encoder
  is not forced and was not measured.
- The spectator's CPU is mostly decode plus UI; it rises when voice is added.
- Voice-only CPU is higher than a raw Opus stream because the WebView2 audio
  graph (echo cancellation, noise suppression, gain, analyser) runs on a
  synthetic 440/660 Hz source. This is the measured capture graph, not a raw
  codec benchmark.
- GPU engine utilization stayed between 0.2% and 3.7% system-wide during these
  states. It is not attributed to Meldrift alone.
- UI jank was not observed; no long tasks were profiled separately. The stream
  stats updated at the expected cadence, and pointer/keyboard control stayed
  responsive while the host encoded.

## Soak and stability

See `docs/STATUS.md` for the recorded duration and final measurements of this
run. The soak ran a voice + stream + spectator pair and an independent
voice-only pair simultaneously, sampling every minute and restarting the stream
every ten minutes.

## Installer and upgrade

| Check | Result |
| --- | --- |
| Installer built for the release | **Verified** — `artifacts/Meldrift-Setup.exe`, 1,839,322 bytes, SHA-256 `9d57c00a5588337b479dbca365784c7cccb6b33225c7941b4836fb09dce622a0` |
| Fresh install, first run | **Verified** — onboarding shown, profile saved |
| Upgrade 0.5.0 → 0.6.0 over the existing install | **Verified** — binary replaced, onboarding skipped, same profile and database loaded, About reported `0.6.0-alpha.1` |
| Uninstall and reinstall | **Not verified** |
| Installer signing | **Not verified** — the installer is unsigned; no certificate is configured |

This was a per-user silent (`/S`) install on the development machine, not a
clean Windows 10 image.

## Security and reliability review

Reviewed authentication/session handling, reconnect and stale-session
behaviour, signaling authorization, voice membership, stream authority, remote
control grants and input release, TURN configuration and logging.

Fixed in M6:

1. **Stale control target after a window closed.** `refreshTargets` kept the
   previous target id even when that window no longer existed, so a later
   approval armed nothing and failed with “Choose the window”. Selection now
   validates the id and falls back to the captured window / first visible
   window. Regression tests added.
2. **Stale voice peers after a reconnect roster change.** A peer that left
   while the socket was down stayed in the mesh (connection, audio element and
   monitor) because only roster members were closed. The mesh now retains only
   the acknowledged roster. Regression test added.
3. **ICE restart only ever attempted once.** `restarting` was never cleared, so
   a call whose restart failed could not try again for the rest of the session.
   It now clears after each attempt. Regression test added.
4. **Endless reconnect against a revoked session.** The socket retried a 401
   handshake forever with no way to distinguish it from a network outage. While
   reconnecting, the client now probes the HTTP session on a slow cadence and
   signs out with “Your session expired” when the server rejects it.

Reviewed and left as documented limitations:

- Session tokens are opaque bearer credentials stored plaintext in the local
  SQLite database and sent to the WebSocket in the query string. No token or
  password is logged by the service or client. Moving the socket credential to
  a short-lived ticket/header and wrapping local storage with DPAPI is a
  scoped follow-up, not a rushed M6 change.
- Session tokens do not expire server-side; sign-out revokes the presented
  token. Multi-device sessions are independent.
- The signaling service does not terminate TLS. Operators must put it behind
  HTTPS/WSS; the docs already say so.
- TURN credentials are only sent to authenticated clients; no TURN server is
  bundled, so relay connectivity is unverified.
- Remote input is ordinary `SendInput` at the OS foreground. Meldrift does not
  bypass anti-cheat, DRM or integrity levels.

No security sandbox is claimed.

## Manual cross-PC checklist (not yet run)

Use two physical Windows PCs on the same LAN first. Give each app its own
account and leave local data alone. Tick only what you actually observe.

- [ ] Both PCs install the same build and show the same version in Settings → About.
- [ ] Register/sign in, add each other as friends and see presence change when one app closes.
- [ ] Create a room on PC A, join by invite code on PC B, exchange chat both ways.
- [ ] Join voice with a real microphone and speakers on both PCs; confirm speech is audible both ways.
- [ ] Mute, deafen, switch input/output device, leave and rejoin voice — no ghost participant remains.
- [ ] Host shares a real game window; PC B sees moving video and real FPS/bitrate stats.
- [ ] Start voice and video together; neither interrupts the other.
- [ ] Enable remote control for the game window, approve PC B, and confirm physical keyboard, mouse buttons, wheel and movement reach the game.
- [ ] Hold a key/button, then revoke from the host: nothing stays held in the game.
- [ ] Hold a key/button, then close the controller app: the host releases input and shows nobody controlling.
- [ ] Minimise and then close the controlled window: control ends and the controller is told why.
- [ ] Disconnect the host network, then restore it: viewer shows reconnecting, not a frozen LIVE frame; voice recovers.
- [ ] Repeat the run over the internet with STUN only, and record the NAT types.
- [ ] Configure a TURN server, repeat over restrictive NAT, and verify relay candidates are selected. Do not mark TURN verified without this.
- [ ] Sign out and close the app during voice/streaming/control; the other PC cleans up.
- [ ] Uninstall on one PC and confirm app data remains; reinstall and confirm it returns.

## Regression tests

Added for the defects above:

- Control target selection: keeps a live id, replaces a closed id, falls back
  to the captured title and then the first visible window.
- Voice mesh roster retention: closes a peer missing from a new roster and
  keeps the rest.
- ICE restart: a second failure after a failed restart still produces a new
  restart offer.
