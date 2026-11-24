# Voice (M3)

Room voice is real WebRTC audio between signed-in Meldrift clients. The
signaling service relays negotiation messages; audio travels peer-to-peer (or
through a TURN relay you configure). Nothing in the UI simulates a participant,
a level, a speaking state or a connection.

## Architecture

```
microphone ──getUserMedia──► gain ──► analyser (local meter, speaking)
                                 └──► MediaStreamDestination ──► Opus ──► DTLS-SRTP ──► peer
peer ──DTLS-SRTP──► remote track ──► <audio> element (audible)
                                └──► analyser (remote speaking)
```

- **Stack:** WebView2 is Chromium, so it provides WebRTC, Opus, ICE, DTLS-SRTP,
  echo cancellation (AEC3), noise suppression and automatic gain control. Voice
  therefore runs in the WebView rather than in Rust. A `webrtc-rs` + `cpal` +
  audio-processing stack would add a second WebRTC implementation, native
  device hot-plug code and extra threads for no quality benefit.
- **Topology:** full mesh, one `RTCPeerConnection` per remote participant, up to
  **8 participants**. The server enforces the cap. Eight people is the practical
  limit before an SFU is required.
- **Codec:** Opus, mono, 48 kHz. Sender `maxBitrate` is 48 kbps per stream and
  DTX is enabled, so silence costs almost nothing. Audio is not re-encoded by
  the app; Chromium's media pipeline does capture → encode → send and receive →
  decode → play without blocking the UI thread.
- **Processing:** the capture request sets `echoCancellation`, `noiseSuppression`
  and `autoGainControl` from Settings. No extra JavaScript noise gate or
  compressor runs on top, so there is only one processing chain.
- **Offer direction:** the participant who joins later offers to everyone
  already in the channel; existing participants answer. This removes glare
  without perfect negotiation. A duplicate join replaces the existing voice
  membership, so there is exactly one peer per person.
- **Capture lifecycle:** leaving voice, switching rooms, signing out, app close
  and a microphone `ended` event all stop capture and close peers. Rejoining
  creates a fresh capture stream and fresh connections; no duplicate microphone
  streams accumulate.
- **Video coexistence (M4):** game streaming uses separate video-only peer
  connections and never adds a video transceiver to a voice connection. Starting,
  stopping or switching a stream does not renegotiate voice; spectators do not
  need to be in the voice channel. See `docs/STREAMING.md`.

## Signaling flow

All voice messages use the authenticated WebSocket (`/ws?token=…`) defined in
`shared/protocol.ts`.

| Direction | Message | Meaning |
| --- | --- | --- |
| client → server | `voice.join { roomId }` | Join the room's voice channel |
| client → server | `voice.leave { roomId }` | Leave it |
| client → server | `voice.state { muted, deafened, speaking }` | Broadcast state changes |
| client → server | `voice.offer { roomId, to, sdp }` | Offer to one voice participant |
| client → server | `voice.answer { roomId, to, sdp }` | Answer one participant |
| client → server | `voice.ice { roomId, to, candidate }` | Trickle ICE candidate |
| server → client | `voice.joined { roomId, selfId, participants }` | Joined; roster of everyone else |
| server → client | `voice.left { roomId }` | You left (or were removed) |
| server → client | `voice.participant.joined / left / state` | Roster changes |
| server → client | `voice.offer / answer / ice { from, … }` | Relayed signaling |
| server → client | `voice.error { error }` | Rejected or invalid request |

Typical join:

```
A: voice.join ─► server (roster empty) ─► voice.joined []
B: voice.join ─► server (roster [A])    ─► voice.joined [A]
                                     └──► voice.participant.joined(B) to A
B: voice.offer(A) ─► server ─► A
A: voice.answer(B) ─► server ─► B
both: voice.ice ⇄ (trickled), DTLS handshake, media flows
```

Server-side rules for every signal:

1. The socket is authenticated and the user is a member of the room.
2. The sender is currently in that room's voice channel on this socket.
3. The target is currently in the same voice channel (not just the room).
4. The target is not the sender; room IDs and user IDs are bounded in length.
5. SDP ≤ 60,000 characters; ICE `candidate` ≤ 2,000; malformed candidates are
   rejected.
6. At most 240 voice signals per socket per 10 seconds.
7. A user can only be in one voice channel at a time; joining another room's
   channel leaves the previous one.
8. Voice membership is in-memory and disappears when the socket closes. It is
   separate from persistent room membership.

The service never decrypts or carries media. SDP contains connection metadata,
not audio.

## ICE configuration (STUN/TURN)

Signed-in clients fetch `GET /api/voice/ice`, which returns the ICE servers and
the participant cap. TURN credentials are only returned to authenticated users,
never in public client configuration or logs.

Server environment variables (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MELDRIFT_STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated `stun:`/`stuns:` URLs |
| `MELDRIFT_TURN_URLS` | none | Comma-separated `turn:`/`turns:` URLs |
| `MELDRIFT_TURN_USERNAME` | none | TURN username |
| `MELDRIFT_TURN_CREDENTIAL` | none | TURN password / static credential |

The client merges these with optional per-device overrides in **Settings →
Audio → Voice network**: a STUN URL, a TURN URL, username and credential. Bad
schemes are ignored; an invalid relay URL does not break calling.

Development defaults are enough when both peers are on the same LAN or on
friendly NATs. They are **not** enough for every network: two peers behind
symmetric NAT or restrictive corporate firewalls need TURN.

### Self-hosted coturn example

```conf
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=meldrift:change-me
realm=turn.example.com
external-ip=203.0.113.10
min-port=49160
max-port=49200
```

Then start the service with:

```bash
MELDRIFT_TURN_URLS="turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp" \
MELDRIFT_TURN_USERNAME="meldrift" \
MELDRIFT_TURN_CREDENTIAL="change-me" \
MELDRIFT_DATA=./data/meldrift.db bun run start
```

For production, use coturn's time-limited credentials (`use-auth-secret` plus a
shared secret) and rotate them; static credentials are fine for a private friend
group but are long-lived bearer secrets. Serve `turns:` (TLS) when clients may be
behind firewalls that block UDP.

### Ports and firewall

| Port | Protocol | Purpose |
| --- | --- | --- |
| 8787 | TCP | Signaling HTTP/WebSocket (put TLS in front for the internet) |
| 3478 | UDP + TCP | STUN/TURN |
| 5349 | TCP + UDP | TURN over TLS (recommended) |
| 49160–49200 | UDP | TURN relay range (coturn `min-port`/`max-port`) |

Open the relay range in both the host firewall and any cloud security group. If
the coturn host is behind NAT, set `external-ip` correctly or relayed candidates
will be unusable.

## Bandwidth and hosting cost

Per participant stream: 48 kbps Opus ceiling plus IP/UDP/SRTP overhead, roughly
**55–70 kbps**; DTX makes silence much cheaper. Approximate totals:

| Situation | Upstream per client | Server bandwidth |
| --- | --- | --- |
| 2-person call, direct P2P | ~60 kbps | none (signaling only) |
| 4-person mesh, direct P2P | ~180 kbps | none |
| 8-person mesh, direct P2P | ~420 kbps | none |
| All streams relayed by TURN | same client bandwidth | ~2× the media rate (in + out): ~0.5 Mbps for 4 people, ~1 Mbps for 8 |

Data volume is small compared with video: a relayed one-hour 2-person call is
roughly 50 MB of TURN traffic; an eight-person fully relayed hour is a few
hundred MB. TURN hosting is therefore a modest but real cost (egress and a
public IP), and Meldrift does not bundle or pay for a relay. Meldrift itself
stays free; whoever runs the TURN server pays for that traffic. If you only use
direct P2P, the signaling service costs almost nothing beyond the SQLite host.

## Windows behaviour

- WebView2 shows its microphone permission prompt on the first join. Allowing it
  grants the WebView2 profile access; denying it is reported as a real capture
  error and voice is not joined.
- WebView2 uses the Windows default communications device unless a device is
  selected. Device removal fires `devicechange`; Meldrift falls back to the
  default microphone and says so, and a running capture ending leaves voice
  rather than pretending to transmit.
- Output selection uses `HTMLAudioElement.setSinkId` when WebView2 supports it.
- The app can be minimised while in voice; audio continues because capture and
  playback live in Chromium's media pipeline, not in React.

## Verified behaviour

Two independent native release clients on one Windows machine (separate
WebView2 profiles and app-data folders) against a local signaling server:

- both joined the same room and voice channel;
- capture opened on both (the available microphones were virtual and silent);
- with synthetic 440/660 Hz input through the app's real capture graph, each
  side decoded the other's tone (measured **662 Hz** and **439 Hz**), proving
  bidirectional audio rather than just a connected peer;
- mute stopped inbound energy and the speaking indicator; unmute restored both;
- deafen muted the remote audio element while RTP kept arriving;
- leave/rejoin left exactly one live peer and one participant per side;
- killing the signaling server showed `Reconnecting…` on both, and after restart
  both rejoined and audio resumed.

Automated coverage lives in `server/test/voice.test.ts` (authorization,
routing, limits, cleanup) and `tests/voice.test.ts` (ICE parsing, speaking
hysteresis, mesh offers, buffering, cleanup, deafen/volume).

## Known limitations

- Mesh only, eight people, no SFU.
- No bundled TURN; strict NATs require your own relay.
- No per-participant volume, recording, spatial audio, or manual Opus tuning.
- Speaking detection is threshold-based, not voice-activity ML.
- Push-to-talk requires window focus.
- Two-machine, real-microphone listening has not been performed; see
  `docs/STATUS.md`.
