import { useEffect, useRef, useState } from 'react';
import { Eye, Gamepad2, Loader2, Monitor, MonitorUp, Radio, Square, Users } from 'lucide-react';
import type { StreamMode, StreamPreset } from '@shared/protocol';
import { Avatar, Button, Spinner } from '@/components/ui';
import { useUi } from '@/state/ui';
import { useStreamRoom, STREAM_VIEWER_LIMIT } from '@/state/streamRoom';
import { useControlRoom } from '@/state/controlRoom';
import { ControlIndicator, ControlSurface } from '@/features/room/ControlSurface';
import { useNetwork } from '@/state/network';
import { useWorkspace } from '@/state/workspace';
import { copyText } from '@/lib/clipboard';
import type { Room } from '@/lib/model';
import {
  STREAM_PRESET_ORDER,
  STREAM_PRESET_SPECS,
  formatBitrate,
  modeLabel,
  presetLabel,
} from '@/lib/stream/model';

function VideoSurface({
  stream,
  muted,
  label,
}: {
  stream: MediaStream;
  muted: boolean;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (callback: () => void) => number;
          cancelVideoFrameCallback?: (id: number) => void;
        })
      | null;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    let active = true;
    let callbackId = 0;
    let lastFrame = performance.now();
    const onFrame = () => {
      if (!active) return;
      lastFrame = performance.now();
      setStalled(false);
      callbackId = video.requestVideoFrameCallback?.(onFrame) ?? 0;
    };
    callbackId = video.requestVideoFrameCallback(onFrame);
    const timer = window.setInterval(() => {
      setStalled(performance.now() - lastFrame > 3000);
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
      video.cancelVideoFrameCallback?.(callbackId);
    };
  }, [stream]);

  return (
    <>
      <video ref={videoRef} className="md-stream__video" autoPlay muted={muted} playsInline />
      {stalled ? (
        <span className="md-stream__stalled">
          <Loader2 size={12} className="md-spin" />
          Waiting for frames — the shared window may be minimised.
        </span>
      ) : null}
      <span className="md-stream__srlabel">{label}</span>
    </>
  );
}

function LiveBadge({ mode }: { mode: StreamMode }) {
  return (
    <span className="md-stage__badge" data-live="true">
      <span className="md-stage__badge-dot" />
      LIVE · {mode === 'desktop' ? 'Display' : 'Window'}
    </span>
  );
}

export function StreamStage({ room, online }: { room: Room; online: boolean }) {
  const profile = useWorkspace((state) => state.profile);
  const openModal = useUi((state) => state.openModal);
  const session = useStreamRoom((state) => state.session);
  const hosting = useStreamRoom((state) => state.hosting);
  const watching = useStreamRoom((state) => state.watching);
  const hostPhase = useStreamRoom((state) => state.hostPhase);
  const viewerPhase = useStreamRoom((state) => state.viewerPhase);
  const previewStream = useStreamRoom((state) => state.previewStream);
  const remoteStream = useStreamRoom((state) => state.remoteStream);
  const viewers = useStreamRoom((state) => state.viewers);
  const hostRuntime = useStreamRoom((state) => state.hostRuntime);
  const viewerRuntime = useStreamRoom((state) => state.viewerRuntime);
  const preset = useStreamRoom((state) => state.preset);
  const error = useStreamRoom((state) => state.error);
  const notice = useStreamRoom((state) => state.notice);
  const stopHosting = useStreamRoom((state) => state.stopHosting);
  const setPreset = useStreamRoom((state) => state.setPreset);
  const watch = useStreamRoom((state) => state.watch);
  const unwatch = useStreamRoom((state) => state.unwatch);
  const pushToast = useUi((state) => state.pushToast);
  const controlSession = useControlRoom((state) => state.session);
  const controlLocal = useControlRoom((state) => state.local);
  const controlRevoke = useControlRoom((state) => state.revoke);
  const controlDisable = useControlRoom((state) => state.disable);
  const selfId = useNetwork((state) => state.user?.id);
  const mineControl = Boolean(
    controlSession?.controller && selfId && controlSession.controller.userId === selfId,
  );

  const copyInvite = async () => {
    const ok = await copyText(room.inviteCode);
    pushToast(ok ? `Invite code ${room.inviteCode} copied` : 'Could not copy invite code', ok ? 'success' : 'error');
  };

  const mine = Boolean(session && profile && session.host.userId === profile.id);
  const openSetup = (mode: StreamMode) => openModal('stream', { roomId: room.id, mode });
  const streamLive = Boolean(session) && !hosting;

  const chrome = (
    <div className="md-stage__chrome">
      {hosting ? (
        <LiveBadge mode={session?.mode ?? 'window'} />
      ) : session ? (
        <span className="md-stage__badge" data-live="true">
          <span className="md-stage__badge-dot" />
          LIVE · {session.mode === 'desktop' ? 'Display' : 'Window'}
        </span>
      ) : (
        <span className="md-stage__badge" data-live="false">
          <span className="md-stage__badge-dot" />
          Session idle
        </span>
      )}
      <span className="md-stage__code">
        <span className="md-eyebrow">Invite</span>
        <button type="button" onClick={() => void copyInvite()} title="Copy invite code">
          {room.inviteCode}
        </button>
      </span>
    </div>
  );

  if (hosting && previewStream) {
    const watchers = viewers.length;
    return (
      <div className="md-stage" data-streaming="true">
        {chrome}
        <div className="md-stream__frame">
          <VideoSurface stream={previewStream} muted label="Your shared screen preview" />
          <div className="md-stream__overlay md-stream__overlay--top">
            <span className="md-stream__pill">
              <Radio size={11} /> You are sharing {modeLabel(session?.mode ?? 'window').toLowerCase()}
            </span>
            <span className="md-stream__pill">
              <Eye size={11} /> {watchers}/{STREAM_VIEWER_LIMIT} watching
            </span>
            {controlSession?.controller ? (
              <ControlIndicator
                name={controlSession.controller.displayName}
                mine={false}
                paused={!controlSession.controllerActive}
              />
            ) : null}
          </div>
          {hostPhase === 'starting' ? (
            <div className="md-stream__scrim">
              <Spinner size={18} /> <span>Starting the stream…</span>
            </div>
          ) : null}
        </div>
        <div className="md-stage__foot md-stream__controls">
          <span className="md-stream__stats">
            {hostRuntime?.width && hostRuntime?.height
              ? `${hostRuntime.width}×${hostRuntime.height}`
              : '—'}
            {' · '}
            {hostRuntime?.fps ? `${Math.round(hostRuntime.fps)} fps` : '—'}
            {' · '}
            {formatBitrate(hostRuntime?.bitrateKbps)}
            {hostRuntime?.quality === 'bandwidth' ? ' · network limited' : ''}
            {hostRuntime?.quality === 'cpu' ? ' · encoder limited' : ''}
          </span>
          <select
            className="md-select md-select--sm"
            value={preset}
            aria-label="Stream quality"
            onChange={(event) => setPreset(event.target.value as StreamPreset)}
          >
            {STREAM_PRESET_ORDER.map((item) => (
              <option key={item} value={item}>
                {STREAM_PRESET_SPECS[item].label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            onClick={() => {
              if (controlSession?.controller) {
                controlRevoke('The host changed the shared window.');
              }
              openSetup(session?.mode ?? 'window');
            }}
          >
            Change source
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Square size={12} />}
            onClick={() => {
              controlDisable();
              stopHosting();
            }}
          >
            Stop stream
          </Button>
        </div>
      </div>
    );
  }

  if (session && watching) {
    return (
      <div className="md-stage" data-streaming="true">
        {chrome}
        <div className="md-stream__frame">
          {remoteStream ? (
            mineControl && controlLocal === 'active' ? (
              <ControlSurface
                stream={remoteStream}
                label={`${session.host.displayName}'s game — remote control`}
              />
            ) : (
              <VideoSurface
                stream={remoteStream}
                muted
                label={`${session.host.displayName}'s stream`}
              />
            )
          ) : (
            <div className="md-stream__blank">
              <Loader2 size={18} className="md-spin" />
              <span>Connecting to {session.host.displayName}'s stream…</span>
            </div>
          )}
          {controlSession?.controller ? (
            <div className="md-stream__overlay md-stream__overlay--top">
              <ControlIndicator
                name={controlSession.controller.displayName}
                mine={mineControl}
                paused={!controlSession.controllerActive}
              />
            </div>
          ) : null}
          {viewerPhase === 'connecting' ? (
            <div className="md-stream__scrim">
              <Spinner size={18} /> <span>Negotiating video…</span>
            </div>
          ) : null}
          {viewerPhase === 'reconnecting' ? (
            <div className="md-stream__scrim">
              <Loader2 size={18} className="md-spin" />
              <span>Stream reconnecting…</span>
            </div>
          ) : null}
          {viewerPhase === 'error' ? (
            <div className="md-stream__scrim md-stream__scrim--error">
              <span>{error ?? 'The stream could not connect.'}</span>
              <Button size="sm" onClick={() => watch()}>
                Retry
              </Button>
            </div>
          ) : null}
        </div>
        <div className="md-stage__foot md-stream__controls">
          <span className="md-stream__stats">
            {viewerRuntime?.width && viewerRuntime?.height
              ? `${viewerRuntime.width}×${viewerRuntime.height}`
              : '—'}
            {' · '}
            {viewerRuntime?.fps ? `${Math.round(viewerRuntime.fps)} fps` : '—'}
            {' · '}
            {formatBitrate(viewerRuntime?.bitrateKbps)}
            {viewerRuntime?.dropped ? ` · ${viewerRuntime.dropped} dropped` : ''}
          </span>
          <Button size="sm" icon={<Square size={12} />} onClick={() => unwatch()}>
            Leave stream
          </Button>
        </div>
      </div>
    );
  }

  if (streamLive && session) {
    return (
      <div className="md-stage">
        {chrome}
        <div className="md-stage__center">
          <span className="md-stream__host-avatar">
            <Avatar
              name={session.host.displayName}
              color={session.host.avatarColor}
              size={44}
            />
          </span>
          <h2 className="md-stage__title">{session.host.displayName} is live</h2>
          <p className="md-stage__text">
            {modeLabel(session.mode)} · {presetLabel(session.preset)} ·{' '}
            {viewers.length}/{STREAM_VIEWER_LIMIT} watching.
            {mine
              ? ' This stream belongs to your account in another window.'
              : ' Watching is optional and uses the host’s upload bandwidth.'}
          </p>
          {error ? <p className="md-note md-note--error">{error}</p> : null}
          {mine ? null : (
            <Button variant="primary" size="sm" icon={<Eye size={14} />} onClick={() => watch()}>
              Watch stream
            </Button>
          )}
        </div>
        <div className="md-stage__foot">
          <span className="md-stage__hint">
            <Monitor size={12} /> Encoded in WebView2 · voice stays connected
          </span>
        </div>
      </div>
    );
  }

  const owner = room.isOwned;
  return (
    <div className="md-stage">
      {chrome}
      <div className="md-stage__center">
        <span className="md-stage__icon">
          <Gamepad2 size={24} />
        </span>
        <h2 className="md-stage__title">
          {owner ? 'Share your game with the room' : 'No one is streaming yet'}
        </h2>
        <p className="md-stage__text">
          {owner
            ? 'Pick a game window or an entire display. Windows shows the real window list; nothing is captured until you choose a source.'
            : 'When the host starts a stream, it appears here. You can watch without leaving the room or voice.'}
        </p>
        {owner ? (
          <div className="md-stream__startrow">
            <Button
              variant="primary"
              size="sm"
              icon={<MonitorUp size={14} />}
              disabled={!online}
              title={online ? 'Share one game window' : 'Sign in to a server to stream'}
              onClick={() => openSetup('window')}
            >
              Share game window
            </Button>
            <Button
              size="sm"
              icon={<Monitor size={14} />}
              disabled={!online}
              onClick={() => openSetup('desktop')}
            >
              Share entire display
            </Button>
          </div>
        ) : null}
        {notice ? <p className="md-hint">{notice}</p> : null}
        {error && !hosting && !watching ? (
          <p className="md-note md-note--error">{error}</p>
        ) : null}
      </div>
      <div className="md-stage__foot">
        <span className="md-stage__hint">
          <Users size={12} /> Up to {STREAM_VIEWER_LIMIT} viewers · P2P video per viewer
        </span>
      </div>
    </div>
  );
}
