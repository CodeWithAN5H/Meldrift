# Remote control and player handoff (M5)

Meldrift lets the host of a live stream hand keyboard and mouse control to one
viewer at a time. The game keeps running on the host's PC, with the host's save
and game state; the viewer's input is forwarded over a dedicated WebRTC data
channel and injected into the host's focused window with the Windows
`SendInput` API.

Remote control is **off by default**, requires the host to choose a target
window and explicitly approve each player, and can be revoked instantly.

## What M5 supports

| Capability | State |
| --- | --- |
| Keyboard press/release forwarding | Working, physical-key mapping (scan code + virtual key) |
| Mouse movement, buttons, vertical wheel | Working, movement coalesced per frame |
| Held-input release on every teardown path | Working |
| One controller at a time, FIFO request queue | Working, maximum 8 queued requests |
| Host approval, rejection, skip, revoke, retake | Working |
| Direct handoff from one approved player to another | Working |
| Emergency stop (UI and `Ctrl+Alt+F12`) | Working |
| Target-window arm/focus validation | Working, focus-based (see limitations) |
| Gamepad forwarding | **Not implemented** — needs a privileged virtual-gamepad driver; future milestone |
| Multiple simultaneous controllers | **Not implemented** — deliberately single-controller in M5 |
| macOS/Linux input | **Not implemented** — Windows only |

## Control model

The host enables control for the current stream by selecting a captured window
from the Rust window list. Enabling does not arm anything; it only opens the
request queue.

```
Disabled ──host enables──▶ Idle (requests allowed)
Idle ──viewer requests──▶ Queued ──host approves──▶ Granted (armed + focused)
Granted ──controller starts──▶ Active (input flowing)
Active ──focus lost──▶ Paused (held input released)
Paused ──host resumes──▶ Active
Active/Granted/Paused ──host revokes / controller releases / disconnect /
                          stream stop / room exit / sign-out / app close /
                          target closed or minimised──▶ Revoked
Idle/Granted ──host disables/emergency stop──▶ Disabled
```

Only the room host can enable, approve, reject, revoke or disable control. The
server derives the host from the room record and the stream session, never from
a client-supplied role. A viewer can only affect its own request or grant.

The queue is first-in, first-out and capped at eight pending requests. The host
can approve any queued player, not only the head, skip a request, or turn
control off entirely. Approving a second player revokes the first grant in the
same server action, so two controllers never overlap.

## Consent and authorization

- The host's approval is required before a grant exists. There is no
  self-grant path: `control.approve` is rejected for every socket except the
  current stream host.
- Each grant has a server-generated id and a 192-bit random token. The token is
  delivered only to the host and the approved controller. The host's input
  session refuses the data channel until a `hello` carrying the matching grant
  id and token arrives.
- The server verifies room membership, stream ownership, queued/approved
  identity, grant id, grant direction and an unrevoked grant for every control
  signal. After a handoff, the old grant id is remembered as revoked and is
  rejected even if an old packet arrives later.
- Input never goes through the signaling server. The server only relays SDP and
  ICE between the host and the approved controller, and only while that grant is
  current.
- Grants live in server memory and are not persisted. Restarting the server,
  closing the app or restarting the stream invalidates them.
- No keyboard or mouse input is read from the host and sent anywhere. Meldrift
  only injects the approved controller's events; it does not capture the host's
  typing.

## Input transport

```
controller WebView2                         host WebView2                     host Rust
keyboard/mouse ── InputBatcher ──▶ RTCPeerConnection (controller offerer)
                                     └─ data channel "meldrift-input"
                                        ordered, reliable, maxRetransmits=0
                                        hello{grantId,token} → input{seq,...}
                                                                     │
                                                     InputReceiver ──┴──▶ InjectionPump
                                                                              │ invoke
                                                                              ▼
                                                                       arm/inject (SendInput)
                                                                              │
                                                                     ack{seq} ──▶ RTT display
```

- One dedicated peer connection per grant, separate from the M4 video peers and
  the M3 voice peers. SDP for input never modifies video or voice SDP.
- The controller creates the offer and the data channel with
  `ordered: true`. Input is therefore reliable and ordered; lost packets are
  retransmitted by SCTP instead of being replayed out of order.
- Sequence numbers start at 1 and must strictly increase. The host ignores
  duplicate or older frames, so a replayed frame cannot execute twice.
- Mouse movement is accumulated between animation frames and sent as one
  `moves` entry. Key and button transitions are always queued; they are never
  coalesced away.
- At most 24 key transitions, 8 move entries and 8 button transitions are
  carried in one frame (well above a human's simultaneous input). Frames are
  capped at 4096 bytes.
- The controller drops mouse-only frames when the data channel has more than
  64 KB buffered, but still sends frames containing key or button transitions,
  so a key-up is never lost to back-pressure.
- The host injects frames through one serialised pump and acknowledges a frame
  only after `SendInput` returns. An unacknowledged frame is not retried, which
  avoids duplicate key events; a new frame carries the current held state.
- Input handling runs outside React rendering; the store only carries control
  state, not per-event input.

The signaling relay enforces a per-socket budget of 160 control messages with a
refill of 40/second, plus a 60,000-byte SDP and 1,200-byte candidate limit.
Abuse produces `control.error` messages rather than disconnecting the chat
socket.

## Windows input API

Injection is implemented in `src-tauri/src/control.rs` with `user32!SendInput`,
declared directly through `#[link(name = "user32")]`; no extra crate is used.

- Keyboard events carry **both** a scan code and a virtual key. Scan codes make
  the input visible to games that read raw input; the virtual key lets normal
  Win32 applications translate characters. Sending scan code alone produced `?`
  in a WinForms text box during development, which is why both are sent.
- Extended keys (arrows, Insert/Delete/Home/End/PageUp/PageDown, right Ctrl/Alt,
  numpad Enter/Divide, Windows/Apps) set `KEYEVENTF_EXTENDEDKEY`.
- Mouse movement is relative (`MOUSEEVENTF_MOVE`), buttons use down/up flags,
  and the vertical wheel uses `MOUSEEVENTF_WHEEL` with the signed delta.
- The host tracks every key and button it pressed. Every teardown path releases
  the still-held set before the session is dropped: pause, revoke, release,
  disconnect, disable, emergency stop, room exit, sign-out, window close, app
  exit and target invalidation.
- The host process also registers the system-wide hotkey `Ctrl+Alt+F12` while
  the app runs. It releases all held input and publishes a `control://emergency`
  event; the UI then revokes and disables control. The hotkey works while the
  game has focus, which is when the host most needs it.
- `SendInput` injects into the current foreground window at the OS level. It is
  not scoped to a window by the kernel. Meldrift therefore arms a specific
  target and checks `GetForegroundWindow` before injecting; if focus moves, it
  stops and releases. This is a safety boundary, not a security sandbox — see
  [Limitations](#known-limitations).

## Target window and focus behavior

The host selects the target from the same real window list used elsewhere
(`EnumWindows`, visible top-level windows, cloaked UWP windows filtered out).
The streamed source and the armed target are separate choices; the host must
confirm the window explicitly, and `control.approve` fails if the selected
window no longer matches the armed target.

- On approval, Meldrift arms the target in Rust (restoring it if minimised) and
  calls `SetForegroundWindow`, then creates the input session. The game is
  focused when the grant begins.
- A focus watchdog samples the foreground window every 400 ms. While the target
  is foreground, injected input flows.
- **Focus lost** (the host alt-tabs, or Meldrift itself is brought forward to
  revoke): injection pauses, every held key/button is released, and the host and
  controller see "paused". The grant survives so the host can press **Resume
  input**; resuming re-focuses the target.
- **Target minimised or closed**: the target is disarmed, the grant is
  invalidated and the controller must be re-approved after selecting a window.
- There is no hidden background forwarding. If the target is not foreground, no
  input is sent.

## Host and controller experience

The room's contextual panel gains a **Remote control** section, and the session
bar/queue tab shows the same queue.

Host:

- Off by default with an explicit note; choose a window and press **Enable
  remote control**.
- See the armed window, the active controller, the queue and control status.
- **Allow** / **Skip** each request, **Revoke**, **Resume input** after a focus
  pause, **Turn control off**, and **Emergency stop**.
- A persistent stage badge and context row show who is controlling.

Spectator:

- **Request control**, **Cancel request**, and a clear pending/rejected/revoked
  state with the host's name.
- Once granted, **Start controlling** requests pointer lock; the stream stage
  becomes the input surface. A persistent banner names the host and offers
  **Release control**; `Esc` releases pointer lock and control.
- The banner states that clicks and keystrokes are going to the host's PC.

The host's local mouse and keyboard always work. Remote control never blocks the
host's own input; Meldrift only adds injected events.

## Lifecycle and cleanup

Every path below was implemented and is covered by automated tests unless marked
native:

| Event | Result |
| --- | --- |
| Controller releases | Server revokes grant, host closes the input channel, Rust releases held input |
| Host revokes | Grant invalidated immediately, controller's channel closed, held input released |
| Host grants another player | Previous grant revoked and its channel closed in the same action |
| Controller socket closes | Server revokes; host session torn down and input released |
| Host socket closes | Stream and control session end; all viewers notified |
| Signaling server restarts | WebSocket reconnect; in-memory grants are gone and clients fall back to disabled |
| Stream stops | Control revoked and disabled before the stream is torn down |
| Host leaves room / signs out | Control room left, grant revoked, Rust disarmed and released |
| Controller leaves room | Controller session released and closed |
| App closes | Rust `CloseRequested`/`RunEvent::Exit` releases every held key/button and unregisters the hotkey |
| Target closes or minimises | Watchdog invalidates the target, pauses/ends forwarding, notifies both sides |
| Target loses focus | Forwarding pauses and held input is released; host can resume |
| Input channel closes | Host session fails closed; controller sees the connection end |
| Stale input after revoke | Channel is closed and the receiver destroyed; the host validates sequence numbers as well |

## Security considerations

- Remote control is a powerful capability and is treated as security-sensitive.
  The default is off, and the host must pick a window and approve the individual
  player.
- Approval is a host-only server action. The server checks the host identity and
  live stream on every control event; a client cannot talk itself into a grant.
- Tokens are random, grant-scoped and never persisted. They are sent only to the
  two participants' data channels.
- No raw input is logged or stored. Frames exist only in memory for the duration
  of a session, and the app does not record them.
- Meldrift does not inject code into games, read or write game memory, bypass
  DRM/anti-cheat, or try to defeat games that block synthetic input.
- The controller can only reach the host's foreground window. It cannot reach
  Meldrift's own UI while the game is focused, which also prevents a controller
  from approving itself through the host's UI.
- Blocked shortcuts on the controller side include the Windows key, `F11`,
  `Alt+Tab`, `Alt+F4`, `Ctrl+Shift+Esc` and `Ctrl+Esc`. These are filtered in the
  browser before transmission; the host-side focus check is the real boundary.

## Performance

The path adds one SCTP hop on the LAN plus `SendInput`. Frame assembly is capped
at one frame per animation frame on the controller; injection is serialised on
the host and never runs on the UI thread.

In the local native run (two app instances, loopback signaling and peer
connection), the controller's HUD reported a **3 ms** data-channel
eknowledgement round trip while input was flowing. That number is measured from
`send()` to the host's `ack` after `SendInput` returned, so it includes the
host-side injection call. It is not an internet measurement, and no CPU figure
is claimed: the run's CPU use was not isolated from the browser and game
processes on the test machine.

The controller's UI displays this measured round trip, and the room panel shows
the host's real control state rather than a simulated latency number.

## Known limitations

- **Focus-based, not window-scoped injection.** Windows `SendInput` targets
  whatever is foreground. Meldrift arms the chosen window and pauses when focus
  leaves it, but a program running as administrator, a UAC secure desktop or
  another process that steals focus can still receive injected events during the
  brief interval before the watchdog notices. Do not grant control to someone
  you do not trust with the PC's foreground input.
- **Elevated games.** A non-elevated Meldrift cannot inject into an elevated
  game because of UIPI. Run Meldrift at the same integrity level as the game, or
  the input will not reach it.
- **Games using raw input / DirectInput** generally work because scan codes are
  sent; games with kernel anti-cheat may ignore or flag synthetic input. Meldrift
  does not attempt to bypass that.
- **Exclusive fullscreen** may not receive injected input reliably; borderless
  windowed is the tested configuration.
- **Pointer lock and `Esc`.** Pressing `Esc` releases the controller's pointer
  lock and control, but the `Esc` key-down is also delivered to the game (most
  games open a pause menu). The UI states this.
- **One controller only.** Multiple simultaneous controllers are not
  implemented, and the Settings screen no longer offers a multiple-controller
  mode.
- **Gamepads are not forwarded.** Reliable gamepad forwarding requires a
  virtual gamepad driver (for example ViGEmBus) installed with administrator
  rights. M5 does not install or require one. Gamepad input remains future work.
- **Remote control requires the desktop app.** It is a Tauri command; the
  browser-only development preview shows the UI but cannot inject input.
- **Latency depends on the network.** LAN performance is measured below; over
  the internet it is bounded by the same peer-to-peer path as voice/video and
  there is no relay or region routing in M5.
- **Two clients on one PC** share one WebView2 profile and one Tauri app-data
  database by default. Two instances require separate `MELDRIFT_DATA_DIR` and
  `WEBVIEW2_USER_DATA_FOLDER` values, and are not a substitute for two PCs.
- M6 re-verified host approval, controller connection, target minimise (host:
  “The game window was minimised.”) and target close (“The game window
  closed.”). In both cases the grant ended, the controller was notified and no
  armed window remained. M6 did not reproduce synthetic keyboard delivery to
  the target; that path is covered by the M5 native run and the Rust/unit
  tests. See `docs/M6_VERIFICATION.md`.
- **The native test drove the UI and browser input through WebView2's DevTools
  protocol** (DOM clicks, `Input.dispatchKeyEvent`/`dispatchMouseEvent`) while
  the app used its real data channel and Rust injected with real `SendInput`.
  This verifies the full transport and injection path, but not physical
  keyboards on two separate machines.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Only the room host can enable remote control" | You are signed in as a viewer. The host must enable it. |
| "Start sharing before enabling control" | Control is scoped to a live stream; start the stream first. |
| "Choose the window you are sharing" | The target list did not produce a match; refresh and pick the window again. |
| "That window changed. Choose it again." | The stream source or target window was replaced; re-select and re-enable. |
| Input does nothing in the game | The game is elevated, uses anti-cheat that ignores synthetic input, or is not foreground. Try borderless windowed and matching integrity levels. |
| Control paused by itself | The target lost foreground focus. Bring the game back and press **Resume input**. |
| No input after approval | Check the controller's banner says "You are controlling" and that the host's panel shows "live"; otherwise the input channel did not connect (NAT/firewall). |
| Stuck key after a crash | Relaunch Meldrift; startup and exit both release tracked input. In an emergency the OS also releases keys on session change. |

## Future improvements

- Virtual gamepad forwarding (ViGEmBus or a signed equivalent) after explicit
  approval and a driver-install flow.
- Multiple controllers for local co-op, with per-player input channels.
- Optional host-side allowlist of keys, and a "hold to control" mode.
- Per-window input scoping on Windows where the OS permits it, rather than
  foreground-only injection.
- A dedicated low-latency input profile over the existing peer connection
  (unreliable/unordered for movement only, reliable for transitions).
- Session recording for diagnostics that stores event counts, never key codes.
