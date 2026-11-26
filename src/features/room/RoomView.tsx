import { useEffect, useState } from 'react';
import {
  Copy,
  Eye,
  Gamepad2,
  ListOrdered,
  Mic,
  PanelRight,
  PhoneOff,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { scopeKey, useRoom, useWorkspace } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useVoiceRoom } from '@/state/voiceRoom';
import { useStreamRoom } from '@/state/streamRoom';
import { useControlRoom } from '@/state/controlRoom';
import { useUi } from '@/state/ui';
import { Button, EmptyState, IconButton, Pill, Spinner } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { ChatThread } from '@/features/chat/ChatThread';
import { StreamStage } from '@/features/room/StreamStage';
import { ControlQueueTab } from '@/features/room/ControlPanel';
import { colorFor, vars } from '@/lib/model';
import { modeLabel } from '@/lib/stream/model';
import { STREAM_VIEWER_LIMIT } from '@/state/streamRoom';
import { copyText } from '@/lib/clipboard';
import { clockTime } from '@/lib/format';
import './room.css';

type RoomTab = 'chat' | 'queue' | 'info';

export function RoomView({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  const [tab, setTab] = useState<RoomTab>('chat');
  const navigate = useUi((state) => state.navigate);
  const openModal = useUi((state) => state.openModal);
  const pushToast = useUi((state) => state.pushToast);
  const toggleContext = useUi((state) => state.toggleContext);
  const contextOpen = useUi((state) => state.contextOpen);
  const online = useNetwork((state) => state.status === 'online');
  const serverMembers = useNetwork((state) => state.members[roomId]);
  const messageCount = useWorkspace(
    (state) => state.messages[scopeKey('room', roomId)]?.length ?? 0,
  );
  const profile = useWorkspace((state) => state.profile);
  const inVoice = useVoiceRoom((state) => state.roomId === roomId);
  const voiceStatus = useVoiceRoom((state) => (state.roomId === roomId ? state.status : 'idle'));
  const voiceCount = useVoiceRoom((state) =>
    state.roomId === roomId ? Object.keys(state.participants).length + 1 : 0,
  );
  const joinVoice = useVoiceRoom((state) => state.join);
  const leaveVoice = useVoiceRoom((state) => state.leave);
  const enterStreamRoom = useStreamRoom((state) => state.enterRoom);
  const leaveStreamRoom = useStreamRoom((state) => state.leaveRoom);
  const enterControlRoom = useControlRoom((state) => state.enterRoom);
  const leaveControlRoom = useControlRoom((state) => state.leaveRoom);
  const streamSession = useStreamRoom((state) => state.session);
  const streamHosting = useStreamRoom((state) => state.hosting);
  const streamWatching = useStreamRoom((state) => state.watching);
  const streamViewers = useStreamRoom((state) => state.viewers);
  const streamMode = useStreamRoom((state) => state.mode);
  const watchStream = useStreamRoom((state) => state.watch);
  const unwatchStream = useStreamRoom((state) => state.unwatch);
  const controlSession = useControlRoom((state) => state.session);
  const controlLocal = useControlRoom((state) => state.local);
  const requestControl = useControlRoom((state) => state.request);
  const cancelControl = useControlRoom((state) => state.cancel);
  const releaseControl = useControlRoom((state) => state.release);
  const startControlling = useControlRoom((state) => state.startControlling);
  const queuedForControl = Boolean(
    controlSession?.queue.some((player) => player.userId === profile?.id),
  );
  const controlAction =
    controlLocal === 'active' || controlLocal === 'connecting'
      ? 'release'
      : controlLocal === 'granted'
        ? 'start'
        : controlLocal === 'requesting' || queuedForControl
          ? 'cancel'
          : 'request';

  useEffect(() => {
    setTab('chat');
  }, [roomId]);

  useEffect(() => {
    enterStreamRoom(roomId);
    enterControlRoom(roomId);
    return () => {
      leaveStreamRoom();
      leaveControlRoom();
    };
  }, [roomId, enterStreamRoom, leaveStreamRoom, enterControlRoom, leaveControlRoom]);

  if (!room) {
    return (
      <div className="md-page">
        <div className="md-card">
          <EmptyState
            icon={<Users size={20} />}
            title="Room not found"
            text="It may have been deleted from this PC."
            action={
              <Button variant="primary" onClick={() => navigate({ kind: 'rooms' })}>
                Back to rooms
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const copyInvite = async () => {
    const ok = await copyText(room.inviteCode);
    pushToast(ok ? `Invite code ${room.inviteCode} copied` : 'Could not copy invite code', ok ? 'success' : 'error');
  };

  return (
    <div className="md-room">
      <header className="md-room__head">
        <span
          className="md-room__tile"
          style={vars({ '--tile-a': colorFor(room.id) })}
          aria-hidden="true"
        >
          {room.kind === 'game' ? <Gamepad2 size={21} /> : <Users size={21} />}
        </span>

        <div className="md-room__heading">
          <h1 className="md-room__title">
            {room.name}
            <span
              className="md-room__livedot"
              data-live={voiceCount > 0}
              title={voiceCount > 0 ? `${voiceCount} in voice` : 'No one is in voice'}
            />
          </h1>
          <p className="md-room__meta">
            {(serverMembers?.length ?? 1)} {(serverMembers?.length ?? 1) === 1 ? 'member' : 'members'}
            <span aria-hidden="true">·</span>
            {room.kind === 'game' ? 'Gaming' : 'Voice'}
            <span aria-hidden="true">·</span>
            {room.gameTitle ?? 'No game selected'}
            {voiceCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                {voiceCount} in voice
              </>
            ) : null}
          </p>
        </div>

        <div className="md-room__actions">
          {!contextOpen ? (
            <IconButton label="Show room details" onClick={toggleContext}>
              <PanelRight size={16} />
            </IconButton>
          ) : null}
          <Button
            size="sm"
            variant={inVoice ? 'default' : 'primary'}
            icon={inVoice ? <PhoneOff size={14} /> : <Mic size={14} />}
            disabled={!inVoice && (!serverMembers || !online)}
            title={
              inVoice
                ? 'Leave this room\u2019s voice channel'
                : serverMembers
                  ? online
                    ? 'Join this room\u2019s voice channel'
                    : 'Reconnect to your server to use voice'
                  : 'Voice needs a server room — sign in and create or join one'
            }
            onClick={() => {
              if (inVoice) {
                leaveVoice();
              } else {
                void joinVoice(room.id);
              }
            }}
          >
            {inVoice
              ? voiceStatus === 'reconnecting'
                ? 'Reconnecting…'
                : voiceStatus === 'joining'
                  ? 'Connecting…'
                  : 'Leave voice'
              : 'Join voice'}
          </Button>
          <Button variant="primary" size="sm" icon={<UserPlus size={14} />} onClick={() => void copyInvite()}>
            Invite
          </Button>
          <Menu
            items={[
              {
                id: 'copy',
                label: 'Copy invite code',
                icon: <Copy size={14} />,
                onSelect: () => void copyInvite(),
              },
              // Only the owner can delete: the server refuses anyone else, so
              // do not offer an action that would fail.
              ...(room.isOwned
                ? [
                    {
                      id: 'delete',
                      label: 'Delete room',
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onSelect: () => openModal('delete-room', { roomId: room.id }),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </header>

      <section className="md-stagecard" aria-label="Game session">
        <StreamStage room={room} online={online} />

        <div className="md-sessionbar">
          <span
            className="md-sessionbar__tile"
            style={vars({ '--tile-a': colorFor(room.id) })}
            aria-hidden="true"
          >
            <Gamepad2 size={18} />
          </span>
          <div className="md-sessionbar__info">
            <p className="md-sessionbar__name">{room.gameTitle ?? 'No game selected'}</p>
            <p className="md-sessionbar__meta">
              {streamSession
                ? `Streaming from ${streamSession.host.displayName}`
                : room.isOwned
                  ? 'Hosted by you'
                  : 'Hosted by a friend'}
              <span aria-hidden="true">·</span>
              <span className="md-sessionbar__status">
                {streamSession
                  ? `${streamHosting ? 'You are sharing' : 'Live'} · ${modeLabel(streamHosting ? streamMode : streamSession.mode)} · ${streamHosting ? streamViewers.length : streamSession.viewers.length}/${STREAM_VIEWER_LIMIT} watching`
                  : 'Idle'}
              </span>
            </p>
          </div>
          <div className="md-sessionbar__actions">
            <Button
              size="sm"
              variant={controlAction === 'release' ? 'danger' : 'primary'}
              icon={<Gamepad2 size={14} />}
              disabled={!streamSession || !controlSession?.enabled || room.isOwned}
              title={
                room.isOwned
                  ? 'You are the host — grant control from the remote control panel'
                  : !streamSession
                    ? 'The host has not started a stream'
                    : !controlSession?.enabled
                      ? 'The host has not enabled remote control'
                      : controlAction === 'release'
                        ? 'Release control and stay in the room'
                        : controlAction === 'start'
                          ? 'The host granted you control — start playing'
                          : controlAction === 'cancel'
                            ? 'Cancel your pending request'
                            : 'Ask the host for a turn'
              }
              onClick={() => {
                if (controlAction === 'release') releaseControl();
                else if (controlAction === 'cancel') cancelControl();
                else if (controlAction === 'start') {
                  if (!streamWatching) watchStream();
                  void startControlling();
                } else requestControl();
              }}
            >
              {controlAction === 'release'
                ? 'Release control'
                : controlAction === 'start'
                  ? 'Start controlling'
                  : controlAction === 'cancel'
                    ? 'Cancel request'
                    : 'Take control'}
            </Button>
            <Button
              size="sm"
              icon={<ListOrdered size={14} />}
              onClick={() => setTab('queue')}
              title="Open the player queue"
            >
              Queue{controlSession?.queue.length ? ` (${controlSession.queue.length})` : ''}
            </Button>
            <Button
              size="sm"
              variant={streamWatching ? 'danger' : 'default'}
              icon={<Eye size={14} />}
              disabled={!streamSession || (streamSession.host.userId === (profile?.id ?? ''))}
              title={
                !streamSession
                  ? 'The host has not started a stream'
                  : streamWatching
                    ? 'Stop watching and leave the stream'
                    : 'Watch the live stream'
              }
              onClick={() => (streamWatching ? unwatchStream() : watchStream())}
            >
              {streamWatching ? 'Leave stream' : 'Spectate'}
            </Button>
          </div>
        </div>
      </section>

      <section className="md-room__panel">
        <div className="md-tabs md-room__tabs">
          <button type="button" className="md-tab" data-active={tab === 'chat'} onClick={() => setTab('chat')}>
            Chat<span className="md-tab__count">{messageCount || ''}</span>
          </button>
          <button type="button" className="md-tab" data-active={tab === 'queue'} onClick={() => setTab('queue')}>
            Player queue
            <span className="md-tab__count">{controlSession?.queue.length ?? 0}</span>
          </button>
          <button type="button" className="md-tab" data-active={tab === 'info'} onClick={() => setTab('info')}>
            Game info
          </button>
        </div>

        <div className="md-room__tabbody">
          {tab === 'chat' ? (
            <ChatThread
              scopeType="room"
              scopeId={room.id}
              placeholder={`Message ${room.name}`}
              emptyTitle="No messages in this room yet"
              emptyText={
                online
                  ? 'Say hello. Messages are delivered to everyone in this room through your server.'
                  : 'Say hello. Messages are saved on this PC until you sign in.'
              }
            />
          ) : null}

          {tab === 'queue' ? <ControlQueueTab /> : null}

          {tab === 'info' ? <RoomInfoTab roomId={room.id} /> : null}
        </div>
      </section>
    </div>
  );
}

function RoomInfoTab({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  const updateRoom = useWorkspace((state) => state.updateRoom);
  const pushToast = useUi((state) => state.pushToast);
  const [name, setName] = useState(room?.name ?? '');
  const [gameTitle, setGameTitle] = useState(room?.gameTitle ?? '');

  useEffect(() => {
    setName(room?.name ?? '');
    setGameTitle(room?.gameTitle ?? '');
  }, [room?.id, room?.name, room?.gameTitle]);

  if (!room) return null;

  return (
    <div className="md-roomtab md-roomtab--form">
      <div className="md-inforow">
        <label className="md-label" htmlFor="room-name">
          Room name
        </label>
        <input
          id="room-name"
          className="md-input"
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => updateRoom(room.id, { name })}
        />
      </div>

      <div className="md-inforow">
        <label className="md-label" htmlFor="room-game">
          Game title
        </label>
        <input
          id="room-game"
          className="md-input"
          value={gameTitle}
          maxLength={60}
          placeholder="No game selected"
          onChange={(event) => setGameTitle(event.target.value)}
          onBlur={() => updateRoom(room.id, { gameTitle: gameTitle.trim() || null })}
        />
      </div>

      <div className="md-inforow">
        <p className="md-label">Invite code</p>
        <div className="md-code">
          <span>{room.inviteCode}</span>
          <Button
            size="sm"
            icon={<Copy size={13} />}
            onClick={async () => {
              const ok = await copyText(room.inviteCode);
              pushToast(ok ? 'Invite code copied' : 'Could not copy code', ok ? 'success' : 'error');
            }}
          >
            Copy
          </Button>
        </div>
        <p className="md-hint">
          Codes are generated locally. Cross-device joining needs the signaling
          service (M2).
        </p>
      </div>

      <dl className="md-infogrid">
        <div>
          <dt>Created</dt>
          <dd>{clockTime(room.createdAt)}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>{clockTime(room.lastActiveAt)}</dd>
        </div>
        <div>
          <dt>You are the</dt>
          <dd>{room.isOwned ? 'Host' : 'Member'}</dd>
        </div>
        <div>
          <dt>Permission model</dt>
          <dd>Host grants control</dd>
        </div>
      </dl>

      <div className="md-infoactions">
        <Pill tone="accent">
          <ShieldCheck size={11} /> Input gated by host
        </Pill>
        <span className="md-hint">
          {room.isOwned
            ? 'No remote input can reach this PC until you explicitly grant control.'
            : 'The host controls your access to the game.'}
        </span>
      </div>
    </div>
  );
}

/** Kept as a light suspense-free placeholder used by future stream mounting. */
export function RoomLoading() {
  return (
    <div className="md-room__loading">
      <Spinner size={18} />
    </div>
  );
}
