import {
  Check,
  Crown,
  Gamepad2,
  Hand,
  ListOrdered,
  Loader2,
  Lock,
  MonitorPlay,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserX,
  X,
} from 'lucide-react';
import type { ControlParticipantView, ControlSessionView } from '@shared/protocol';
import { Avatar, Button, Spinner } from '@/components/ui';
import { useControlRoom } from '@/state/controlRoom';
import { useNetwork } from '@/state/network';
import { useStreamRoom } from '@/state/streamRoom';
import { useUi } from '@/state/ui';
import type { Room } from '@/lib/model';

/* --------------------------------------------------------------------------
   Remote-control panel.

   Host and spectator see the same facts (who is controlling, who is queued,
   which window was armed). Only the host sees grant/revoke actions. Nothing is
   granted implicitly: approving a queued request arms that window first, and a
   spectator has to press Start after a grant before any input is sent.
   -------------------------------------------------------------------------- */

function ControllerRow({
  controller,
  active,
  paused,
  compact,
}: {
  controller: ControlParticipantView;
  active: boolean;
  paused: boolean;
  compact?: boolean;
}) {
  return (
    <div className="md-control__who" data-active={active && !paused}>
      <Avatar name={controller.displayName} color={controller.avatarColor} size={compact ? 26 : 32} />
      <div className="md-control__whobody">
        <p className="md-control__name">
          {controller.displayName}
          {paused ? ' · paused' : active ? ' · controlling' : ' · connecting'}
        </p>
        <p className="md-control__meta">
          {paused
            ? 'Game lost focus — input is released'
            : active
              ? 'Keyboard and mouse are live'
              : 'Waiting for their input channel'}
        </p>
      </div>
      <Gamepad2 size={14} className="md-control__icon" data-on={active && !paused} />
    </div>
  );
}

export function ControlQueue({ compact }: { compact?: boolean }) {
  const session = useControlRoom((state) => state.session);
  const approve = useControlRoom((state) => state.approve);
  const reject = useControlRoom((state) => state.reject);
  const busy = useControlRoom((state) => state.busy);
  const selfId = useNetwork((state) => state.user?.id);
  const armed = useControlRoom((state) => state.armed);
  const isHost = Boolean(selfId && session && selfId === session.host.userId);

  if (!session || !session.enabled) {
    return (
      <p className="md-context__empty">
        <Lock size={14} /> Remote control is off. The host must enable it for this stream.
      </p>
    );
  }

  return (
    <>
      {session.controller ? (
        <ControllerRow
          controller={session.controller}
          active={session.controllerActive}
          paused={Boolean(isHost && armed?.paused)}
          compact={compact}
        />
      ) : (
        <p className="md-context__empty">
          <Hand size={14} /> Nobody is controlling. The host can grant a queued player.
        </p>
      )}

      {session.queue.length === 0 ? (
        <p className="md-context__empty">
          <ListOrdered size={14} /> No control requests waiting.
        </p>
      ) : (
        <ul className="md-controlqueue">
          {session.queue.map((player, index) => (
            <li key={player.userId} className="md-controlqueue__row">
              <span className="md-controlqueue__pos">{index + 1}</span>
              <Avatar name={player.displayName} color={player.avatarColor} size={26} />
              <span className="md-controlqueue__name">{player.displayName}</span>
              {isHost ? (
                <span className="md-controlqueue__actions">
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Check size={12} />}
                    disabled={busy}
                    onClick={() => void approve(player.userId)}
                  >
                    Allow
                  </Button>
                  <Button size="sm" icon={<X size={12} />} onClick={() => reject(player.userId)}>
                    Skip
                  </Button>
                </span>
              ) : (
                <span className="md-controlqueue__wait">waiting</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function HostControl() {
  const session = useControlRoom((state) => state.session);
  const armed = useControlRoom((state) => state.armed);
  const targets = useControlRoom((state) => state.targets);
  const targetId = useControlRoom((state) => state.targetId);
  const error = useControlRoom((state) => state.error);
  const busy = useControlRoom((state) => state.busy);
  const enable = useControlRoom((state) => state.enable);
  const disable = useControlRoom((state) => state.disable);
  const revoke = useControlRoom((state) => state.revoke);
  const resumeTarget = useControlRoom((state) => state.resumeTarget);
  const emergencyStop = useControlRoom((state) => state.emergencyStop);
  const refreshTargets = useControlRoom((state) => state.refreshTargets);
  const setTargetId = useControlRoom((state) => state.setTargetId);
  const pushToast = useUi((state) => state.pushToast);

  if (!session?.enabled) {
    return (
      <div className="md-control">
        <p className="md-control__note">
          <ShieldCheck size={13} /> Off by default. Pick the window you are sharing, then enable
          control. No key or mouse event reaches this PC until you approve a player.
        </p>
        <div className="md-control__targetrow">
          <select
            className="md-select md-select--sm"
            aria-label="Window to control"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            <option value="">Choose a window…</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.title} — {target.process}
                {target.minimized ? ' (minimised)' : ''}
              </option>
            ))}
          </select>
          <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void refreshTargets()}>
            Refresh
          </Button>
        </div>
        <div className="md-control__actions">
          <Button
            size="sm"
            variant="primary"
            icon={<ShieldCheck size={13} />}
            disabled={busy || !targetId}
            onClick={() =>
              void enable().then((ok) => {
                if (ok) pushToast('Remote control enabled for this stream', 'success');
                else pushToast(useControlRoom.getState().error ?? 'Could not enable control', 'error');
              })
            }
          >
            Enable remote control
          </Button>
        </div>
        {error ? <p className="md-note md-note--error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="md-control">
      <p className="md-control__note">
        <ShieldCheck size={13} /> On for <strong>{session.targetLabel}</strong>. You stay the host;
        approving focuses that window and arms it.
      </p>

      <ControlQueue />

      {session.controller ? (
        <div className="md-control__actions">
          <Button
            size="sm"
            variant="danger"
            icon={<ShieldAlert size={13} />}
            onClick={() => emergencyStop()}
          >
            Emergency stop
          </Button>
          {armed?.paused ? (
            <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={() => void resumeTarget()}>
              Resume input
            </Button>
          ) : null}
          <Button size="sm" icon={<UserX size={13} />} onClick={() => revoke()}>
            Revoke
          </Button>
        </div>
      ) : (
        <div className="md-control__actions">
          <Button size="sm" variant="danger" icon={<ShieldAlert size={13} />} onClick={() => emergencyStop()}>
            Emergency stop
          </Button>
          <Button size="sm" onClick={() => disable()}>
            Turn control off
          </Button>
        </div>
      )}

      {armed?.paused ? (
        <p className="md-note md-note--warn">
          The game lost focus, so Meldrift released every held key and stopped injecting. Resume
          brings the game back and continues the same grant.
        </p>
      ) : null}
      {armed ? (
        <p className="md-control__armed">
          <MonitorPlay size={12} /> Armed: {armed.title} · {armed.process}
        </p>
      ) : (
        <p className="md-control__armed" data-idle="true">
          <Lock size={12} /> Nothing armed. The game is not being focused or injected yet.
        </p>
      )}
      {error ? <p className="md-note md-note--error">{error}</p> : null}
    </div>
  );
}

function SpectatorControl() {
  const session = useControlRoom((state) => state.session);
  const local = useControlRoom((state) => state.local);
  const notice = useControlRoom((state) => state.notice);
  const error = useControlRoom((state) => state.error);
  const latency = useControlRoom((state) => state.latencyMs);
  const request = useControlRoom((state) => state.request);
  const cancel = useControlRoom((state) => state.cancel);
  const startControlling = useControlRoom((state) => state.startControlling);
  const release = useControlRoom((state) => state.release);
  const watching = useStreamRoom((state) => state.watching);
  const watch = useStreamRoom((state) => state.watch);
  const selfId = useNetwork((state) => state.user?.id);

  const queued = Boolean(session?.queue.some((player) => player.userId === selfId));

  if (!session?.enabled) {
    return (
      <p className="md-control__note">
        <Lock size={13} /> The host has not enabled remote control. You can still watch and talk.
      </p>
    );
  }

  if (local === 'active' || local === 'connecting') {
    return (
      <div className="md-control">
        <p className="md-control__live">
          <Gamepad2 size={14} /> You have control
          {latency !== null ? ` · ${latency} ms round trip` : ''}
        </p>
        <p className="md-control__note">
          Esc releases control. If the host switches windows, input pauses and your held keys are
          released.
        </p>
        <Button size="sm" variant="danger" onClick={() => release()}>
          Release control
        </Button>
        {error ? <p className="md-note md-note--error">{error}</p> : null}
      </div>
    );
  }

  if (local === 'granted') {
    return (
      <div className="md-control">
        <p className="md-control__live">
          <Hand size={14} /> The host granted you control
        </p>
        <p className="md-control__note">
          Start controlling when you are ready. Meldrift will capture your mouse; press Esc to let
          go. Nothing is sent until you press Start.
        </p>
        <div className="md-control__actions">
          <Button
            size="sm"
            variant="primary"
            icon={<Play size={12} />}
            onClick={() => {
              if (!watching) watch();
              void startControlling();
            }}
          >
            Start controlling
          </Button>
          <Button size="sm" onClick={() => release()}>
            Decline
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="md-control">
      <ControlQueue compact />

      {local === 'requesting' || queued ? (
        <div className="md-control__actions">
          <span className="md-control__waiting">
            <Loader2 size={13} className="md-spin" /> Waiting for the host
          </span>
          <Button size="sm" onClick={() => cancel()}>
            Cancel request
          </Button>
        </div>
      ) : session.controller ? (
        <p className="md-control__note">
          {session.controller.displayName} is playing. You can join the queue; the host decides the
          order.
        </p>
      ) : (
        <p className="md-control__note">
          Ask for a turn. The host approves every request, and only one player controls at a time.
        </p>
      )}

      {local === 'revoked' || local === 'error' ? (
        <p className="md-note md-note--warn">{notice ?? error ?? 'Control ended.'}</p>
      ) : null}

      {local !== 'requesting' && !queued ? (
        <Button size="sm" variant="primary" icon={<Hand size={12} />} onClick={() => request()}>
          Request control
        </Button>
      ) : null}
      {error ? <p className="md-note md-note--error">{error}</p> : null}
    </div>
  );
}

export function ControlPanel({ room }: { room: Room }) {
  const streaming = useStreamRoom((state) => Boolean(state.session));
  const hosting = useStreamRoom((state) => state.hosting);
  const selfId = useNetwork((state) => state.user?.id);
  const session = useControlRoom((state) => state.session);
  const isHost = room.isOwned || Boolean(session && selfId && session.host.userId === selfId);

  if (!streaming) {
    return (
      <p className="md-context__empty">
        <MonitorPlay size={14} /> Remote control becomes available when the host starts sharing.
      </p>
    );
  }

  return (
    <div className="md-controlpanel">
      {isHost ? (
        hosting ? (
          <HostControl />
        ) : (
          <p className="md-context__empty">
            <Crown size={14} /> Only the account hosting the stream can manage control.
          </p>
        )
      ) : (
        <SpectatorControl />
      )}
    </div>
  );
}

/** Used by the room's Player queue tab. */
export function ControlQueueTab() {
  const session = useControlRoom((state) => state.session);
  const enabled = Boolean(session?.enabled);
  const selfId = useNetwork((state) => state.user?.id);
  const local = useControlRoom((state) => state.local);
  const request = useControlRoom((state) => state.request);
  const cancel = useControlRoom((state) => state.cancel);
  const streaming = useStreamRoom((state) => Boolean(state.session));
  const hostId = useStreamRoom((state) => state.session?.host.userId);
  const isHost = Boolean(selfId && hostId === selfId);

  return (
    <div className="md-roomtab">
      <div className="md-queuehead">
        <div>
          <p className="md-eyebrow">Control mode</p>
          <p className="md-queuehead__mode">
            Single active player · {session?.queue.length ?? 0} queued
          </p>
        </div>
        {!streaming ? (
          <span className="md-hint">Start a stream first</span>
        ) : enabled ? (
          isHost ? (
            <span className="md-hint">Approve in the context panel</span>
          ) : local === 'requesting' ? (
            <Button size="sm" onClick={() => cancel()}>
              Cancel request
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => request()}>
              Request control
            </Button>
          )
        ) : (
          <span className="md-hint">Remote control is off</span>
        )}
      </div>

      {streaming ? (
        <ControlQueue />
      ) : (
        <p className="md-context__empty">
          <ListOrdered size={14} /> The queue opens when the host starts sharing and enables control.
        </p>
      )}

      <p className="md-hint">
        One player controls at a time. The host can revoke instantly with Ctrl+Alt+F12, and every
        handoff releases held keys before the next player starts.
      </p>
    </div>
  );
}

/** Small status strip used by the room stage. */
export function ControlStageBadge({ session }: { session: ControlSessionView | null }) {
  const selfId = useNetwork((state) => state.user?.id);
  const local = useControlRoom((state) => state.local);
  if (!session?.enabled || !session.controller) return null;
  const mine = session.controller.userId === selfId;
  return (
    <span className="md-control__stagebadge" data-mine={mine}>
      {local === 'active' ? <Gamepad2 size={11} /> : <Spinner size={11} />}
      {mine
        ? local === 'active'
          ? 'You have control'
          : 'You are being connected'
        : `${session.controller.displayName} is controlling`}
    </span>
  );
}
