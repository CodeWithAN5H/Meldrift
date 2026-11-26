# Game streaming (M4)

Meldrift streams a host's game to the people in their room. The video is real
capture and real WebRTC; nothing is routed through the signaling service, and a
spectator only sees a picture when frames are actually arriving.

- **Default:** one game/application window, chosen in Windows' own picker.
- **Optional:** an entire display, chosen explicitly.
- **Audio:** voice keeps its own WebRTC connections. Video never renegotiates or
  tears down voice.
- **Format:** one video-only peer connection per viewer (host → viewer mesh),
  capped at four viewers per room.

## Starting from the Games library

The Games view is the entry point to this pipeline. A saved game shows whether a
window with its executable name is running (the same window list remote control
uses), and **Start room** creates or opens the game's owned room and opens the
stream setup. **Launch** runs the executable path the user saved, only when the
user presses it.

Meldrift still cannot preselect the capture surface: Windows' picker is the
consent boundary, so the host chooses the game window there. The library reports
the matching window title to make that choice unambiguous, but it never captures
anything before the picker returns.

## Capture architecture

Capture uses **`navigator.mediaDevices.getDisplayMedia` inside WebView2**. In the
WebView2 runtime Chromium uses **Windows Graphics Capture** for window and
monitor surfaces, so frames stay inside the browser's GPU/video pipeline.

Why this and not a Rust capture path:

- No full-resolution frames are copied between Rust and JavaScript, and no
  high-frequency IPC channel is created.
- The same WebView2 runtime already owns the M3 WebRTC stack (ICE, DTLS-SRTP,
  Opus, video codecs, hardware encode/decode), so there is no second WebRTC
  implementation.
- Windows Graphics Capture is the supported Win32 capture surface for
  non-injected desktop apps. Meldrift does not inject into games, hook graphics
  APIs or bypass protected-content restrictions.

The trade-off is that capture runs in Chromium's sandbox and depends on the
installed WebView2 runtime. It cannot capture a window that Windows itself
refuses to share (DRM/protected content, some exclusive-fullscreen modes) — the
app reports that instead of working around it.

### Window capture (default)

`getDisplayMedia` is called with Chromium picker hints:

```ts
{
  video: { displaySurface: 'window', width, height, frameRate },
  audio: false,
  monitorTypeSurfaces: 'exclude',
  surfaceSwitching: 'exclude',
  selfBrowserSurface: 'exclude',
  systemAudio: 'exclude'
}
```

`monitorTypeSurfaces: 'exclude'` keeps the picker's **Entire screen** tab out of
window mode, so a window stream cannot silently become a desktop stream. The
picker still lists real window titles and thumbnails; Meldrift does not enumerate
or capture anything before the host confirms a source. Selecting **Cancel**
produces `NotAllowedError` and no capture starts.

### Desktop capture (optional)

The host explicitly chooses **Share entire display**. Then
`monitorTypeSurfaces: 'include'` and `displaySurface: 'monitor'` are used. The
setup dialog warns that everything on the selected display is visible, including
notifications. Switching between window and display is always an explicit host
action; there is no automatic fallback.

### Capture constraints

| Preset | Capture request (capped by Settings) | Target bitrate |
| --- | --- | --- |
| Auto | up to 1280×720, 30 fps | 3.0 Mbps |
| Smooth | up to 1280×720, 30 fps | 1.8 Mbps |
| Balanced | up to 1920×1080, 30 fps | 4.0 Mbps |
| Quality | up to 1920×1080, 60 fps | 8.0 Mbps |

Settings → Streaming sets the host's ceiling (720p/1080p, 30/60 fps). The
preset's resolution and frame rate are clamped to that ceiling. 1080p60 is never
forced; the encoder and network decide what is actually sustainable.

### Capture lifecycle

- Capture starts only from **Share game window** / **Share entire display** (or
  the voice dock's screen button) and only after the Windows picker returns.
- A persistent **LIVE** badge and a local preview are shown while capture runs.
- **Stop stream** stops every capture track immediately.
- **Change source** opens the picker while the old stream keeps running. The old
  track is only stopped after the new source is accepted and `replaceTrack`
  succeeds; cancelling leaves the stream untouched. No app restart is needed.
- If the captured window closes or the browser's own stop-sharing control ends
  the track, the track's `ended` event tears the stream down and tells the room.
  A frozen frame is never left behind as "connected".
- Capture stops on leaving the room, signing out, losing signaling, or closing
  the app.

## WebRTC video transport

Video deliberately uses **separate `RTCPeerConnection`s from voice**, one per
viewer:

- A video negotiation error cannot break audio.
- Spectators do not have to be in the voice channel.
- Video can stop/restart/switch sources without renegotiating the voice SDP.
- Voice mute/deafen/device changes cannot accidentally touch video senders.

Each viewer connection carries exactly one video track and no audio. The host is
always the offerer, so no glare handling is needed. A source switch uses
`sender.replaceTrack()` on every viewer connection and a quality change uses
`sender.setParameters()`; peer connections are not recreated for ordinary
adjustments.

The browser negotiates the codec. The installed WebView2 runtime offers VP8,
H.264, VP9 and AV1; Chromium prefers a hardware-accelerated encoder when the GPU
supports one and falls back to software encoding automatically. Meldrift does not force a codec or assume a hardware encoder exists. The host records the
negotiated codec and encoder implementation from WebRTC stats alongside the
resolution, frame rate and bitrate used by the adaptive controller.

### Signaling

`shared/protocol.ts` carries:

| Client → server | Server → client |
| --- | --- |
| `stream.start` (mode, preset) | `stream.started` (host, mode, preset, viewers) |
| `stream.stop` | `stream.stopped` (reason) |
| `stream.watch` / `stream.unwatch` | `stream.viewers`, `stream.viewer.joined`, `stream.viewer.left` |
| `stream.preset` | `stream.error` |
| `stream.sync` | `stream.offer`, `stream.answer`, `stream.ice` (relayed only) |
| `stream.offer`, `stream.answer`, `stream.ice` | |

Server checks:

- The socket is authenticated and is a member of the room.
- Only the **room owner** can start a stream. `stream.start` on the same host
  socket reconfigures the existing stream; another socket cannot take it over.
- Only the streaming host socket can stop it or change quality.
- A viewer must be a room member, cannot be the host, and cannot exceed the
  four-viewer cap.
- SDP is limited to 60 kB, ICE candidates to 2 kB, and stream signaling is
  rate-limited per socket (300 messages / 10 s).
- Offer/answer/ICE are relayed only between the current host and a current
  viewer. Non-members, non-viewers and cross-room targets are rejected.
- When the host socket closes, the stream ends for everyone. A viewer socket
  close only removes that viewer.

Stream state is in memory, like voice membership. The service never receives,
decodes or forwards video frames.

## Quality presets and adaptation

| Preset | Behaviour |
| --- | --- |
| **Auto** (default) | 720p30 baseline, adapts bitrate and scale to the measured link. |
| **Smooth** | Keeps frame rate; sacrifices resolution first when the link tightens. |
| **Balanced** | 1080p30 with bitrate headroom; mixed degradation. |
| **Quality** | 1080p60 where possible; preserves resolution and lowers frame rate first. |

Every two seconds the host reads WebRTC sender statistics for each viewer and
applies one adaptation step:

- **Pressure:** more than 3% packet loss, `qualityLimitationReason: bandwidth`,
  available outgoing bitrate below 1.15× the current target, or RTT over 250 ms.
  Bitrate drops 15%. Smooth/balanced/Auto increase the encoder downscale; Quality
  reduces frame rate first.
- **Healthy:** under 1% loss, no bandwidth limitation, available bitrate above
  1.4× the target, RTT under 180 ms. Bitrate rises 6% toward the preset ceiling,
  scale recovers, then frame rate.
- Values are clamped to the preset's minimum/maximum, and
  `degradationPreference` tells the encoder what to protect.

The UI shows the real encoded resolution, frame rate, approximate outgoing
bitrate, dropped frames (viewer) and whether the stream is network- or
encoder-limited. These are measurements from `RTCPeerConnection.getStats()`, not
invented labels. The adaptive loop never recreates peer connections.

## Bandwidth: host upload is the real limit

Each viewer gets its own encoded stream. Host upstream therefore grows nearly
linearly with viewers:

| Viewers | Auto (~3 Mbps) | Balanced (~4 Mbps) | Quality (~8 Mbps) |
| --- | --- | --- | --- |
| 1 | ~3 Mbps | ~4 Mbps | ~8 Mbps |
| 2 | ~6 Mbps | ~8 Mbps | ~16 Mbps |
| 4 (cap) | ~12 Mbps | ~16 Mbps | ~32 Mbps |

Real encoders often send less than the ceiling for static scenes, but plan for
the ceiling. Four viewers is the enforced cap because this is a host→viewer mesh,
not an SFU. Voice adds about 48 kbps per voice peer in each direction.

If a TURN server relays the video, the **TURN operator** carries roughly the
same bitrate in and out for each viewer (about 2× the media rate), and each
client's own upstream still carries its outgoing media to TURN. TURN is optional
and self-hosted; see `docs/VOICE.md`.

## STUN/TURN

Video reuses the same authenticated ICE configuration as voice:

- Server defaults (`MELDRIFT_STUN_URLS`, optional `MELDRIFT_TURN_URLS` with
  credentials) from `GET /api/voice/ice`.
- Per-device overrides in Settings → Audio.
- STUN is enough for many home NATs. Two peers behind symmetric/strict NATs
  require TURN. Meldrift does not claim that P2P works on every network.

## Windows and WebView2 limitations

- **WebView2 is required.** Capture and WebRTC come from that runtime. An old
  runtime can fail with `NotSupportedError`; update the WebView2 Runtime.
- **The picker is WebView2's.** It lists window titles, not a custom Meldrift
  source list. Some system windows and protected surfaces are not offered.
- **Minimised windows** may stop producing new frames. Meldrift shows "waiting
  for frames" instead of claiming a healthy stream; restore the window to
  resume.
- **Exclusive fullscreen / protected content** may be black or refused. This is
  an OS/game restriction and is not bypassed. Prefer borderless windowed mode.
- **DRM-protected surfaces** cannot be captured; `SecurityError` is reported.
- **Display changes** (unplug, resolution/mode change) can end the capture track
  or resize it. The stream ends cleanly with a reason if the track ends.
- **No system/game audio capture** in M4. Voice is the audio channel; adding
  game audio is future work.
- **Window picker source switching** is disabled; use **Change source** so
  Meldrift can tell the room and replace the track deliberately.

## Troubleshooting

| Symptom / error | Meaning |
| --- | --- |
| "Screen sharing was cancelled." | The picker was closed. Nothing was captured. |
| "Windows or WebView2 did not allow capture…" | Permission/policy denial; check Windows screen-recording settings. |
| "Windows could not read that window…" | Protected or exclusive-fullscreen surface; use borderless windowed. |
| "Windows blocked capture of that surface (DRM…)" | Protected content; not bypassable. |
| "This WebView2 version does not support screen capture." | Update the WebView2 Runtime. |
| Spectator sees "Negotiating video…" for 20 s | No video path. Check both clients' connection, then Retry; strict NATs may need TURN. |
| "This stream is full (4 viewers)" | Host upload cap; wait for a viewer to leave. |
| Video stops when the host's connection drops | By design: the stream ends rather than freezing. Restart it after reconnecting. |

## Verification scope

Automated tests cover preset bounds, capture constraint selection, error
mapping, adaptive controller behaviour, stats parsing, per-viewer connection
lifecycle, track replacement, encoding parameters, cleanup, and server
authorization/routing/rate limits/viewer caps. Native results are recorded in
`docs/STATUS.md` and the M4 release notes.

## Future scaling

A host→viewer mesh is deliberately the M4 shape: no mandatory infrastructure,
no media server, and a four-viewer cap that a normal home upstream can carry.
Larger audiences need an SFU (for example a self-hosted media server) that
receives one host stream and forwards it. That changes hosting cost and
deployment, so it is not part of M4.
