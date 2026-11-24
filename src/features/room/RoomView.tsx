import { useEffect, useState } from 'react';
import {
  Copy,
  Eye,
  Gamepad2,
  ListOrdered,
  PanelRight,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { scopeKey, useRoom, useWorkspace } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useUi } from '@/state/ui';
import { Button, EmptyState, IconButton, Pill, Spinner } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { ChatThread } from '@/features/chat/ChatThread';
import { colorFor, vars } from '@/lib/model';
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
  const messageCount = useWorkspace(
    (state) => state.messages[scopeKey('room', roomId)]?.length ?? 0,
  );

  useEffect(() => {
    setTab('chat');
  }, [roomId]);

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
            <span className="md-room__livedot" data-live="false" title="No live session" />
          </h1>
          <p className="md-room__meta">
            1 member<span aria-hidden="true">·</span>
            {room.kind === 'game' ? 'Gaming' : 'Voice'}
            <span aria-hidden="true">·</span>
            {room.gameTitle ?? 'No game selected'}
          </p>
        </div>

        <div className="md-room__actions">
          {!contextOpen ? (
            <IconButton label="Show room details" onClick={toggleContext}>
              <PanelRight size={16} />
            </IconButton>
          ) : null}
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
              {
                id: 'delete',
                label: 'Delete room',
                icon: <Trash2 size={14} />,
                danger: true,
                onSelect: () => openModal('delete-room', { roomId: room.id }),
              },
            ]}
          />
        </div>
      </header>

      <section className="md-stagecard" aria-label="Game session">
        <div className="md-stage">
          <div className="md-stage__chrome">
            <span className="md-stage__badge" data-live="false">
              <span className="md-stage__badge-dot" />
              Session idle
            </span>
            <span className="md-stage__code">
              <span className="md-eyebrow">Invite</span>
              <button type="button" onClick={() => void copyInvite()}>
                {room.inviteCode}
              </button>
            </span>
          </div>

          <div className="md-stage__center">
            <span className="md-stage__icon">
              <Gamepad2 size={24} />
            </span>
            <h2 className="md-stage__title">No game session running</h2>
            <p className="md-stage__text">
              The host captures their own game and the room watches live. Capture,
              adaptive streaming and spectator delivery arrive in milestone M4.
            </p>
            <Button size="sm" onClick={() => navigate({ kind: 'games' })}>
              Open game library
            </Button>
          </div>

          <div className="md-stage__foot">
            <span className="md-stage__hint">
              <ShieldCheck size={12} />
              Remote input is never enabled automatically.
            </span>
          </div>
        </div>

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
              {room.isOwned ? 'Hosted by you' : 'Hosted by a friend'}
              <span aria-hidden="true">·</span>
              <span className="md-sessionbar__status">Idle</span>
            </p>
          </div>
          <div className="md-sessionbar__actions">
            <Button
              size="sm"
              variant="primary"
              icon={<Gamepad2 size={14} />}
              disabled
              title="Take control needs a live session (M4/M5)"
            >
              Take control
            </Button>
            <Button size="sm" icon={<ListOrdered size={14} />} disabled title="The queue opens with a live session">
              Queue
            </Button>
            <Button size="sm" icon={<Eye size={14} />} disabled title="Spectating needs a live stream">
              Spectate
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
            Player queue<span className="md-tab__count">0</span>
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

          {tab === 'queue' ? <QueueTab /> : null}

          {tab === 'info' ? <RoomInfoTab roomId={room.id} /> : null}
        </div>
      </section>
    </div>
  );
}

function QueueTab() {
  const settings = useWorkspace((state) => state.settings);
  const updateSettings = useWorkspace((state) => state.updateSettings);

  return (
    <div className="md-roomtab">
      <div className="md-queuehead">
        <div>
          <p className="md-eyebrow">Control mode</p>
          <p className="md-queuehead__mode">
            {settings.controlMode === 'single' ? 'Single active player' : 'Multiple controllers'}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() =>
            void updateSettings({
              controlMode: settings.controlMode === 'single' ? 'multi' : 'single',
            })
          }
        >
          Use {settings.controlMode === 'single' ? 'multiple' : 'single'}
        </Button>
      </div>

      <EmptyState
        icon={<ListOrdered size={19} />}
        title="The queue is empty"
        text="Friends can request control once a live session is running. The host always decides who plays next, and can take control back instantly."
        compact
      />
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
