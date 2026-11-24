import { useMemo } from 'react';
import { Gamepad2, Headphones, Layers, Plus } from 'lucide-react';
import { useWorkspace, scopeKey } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useUi } from '@/state/ui';
import { Avatar, IconButton } from '@/components/ui';
import { colorFor, vars, type Message, type Room } from '@/lib/model';
import { clockTime, relativeTime } from '@/lib/format';
import { VoiceCard } from '@/features/voice/VoiceCard';
import './sidebar.css';

export function RoomSidebar() {
  const rooms = useWorkspace((state) => state.rooms);
  const messages = useWorkspace((state) => state.messages);
  const profile = useWorkspace((state) => state.profile);
  const view = useUi((state) => state.view);
  const navigate = useUi((state) => state.navigate);
  const openModal = useUi((state) => state.openModal);

  const recent = useMemo<Message[]>(() => {
    const all: Message[] = [];
    for (const room of rooms) {
      const list = messages[scopeKey('room', room.id)];
      if (list && list.length) all.push(list[list.length - 1]);
    }
    return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  }, [messages, rooms]);

  const activeRoomId = view.kind === 'room' ? view.roomId : null;

  return (
    <aside className="md-side" aria-label="Rooms">
      <div className="md-side__scroll">
        <div className="md-side__head">
          <h2 className="md-eyebrow">Your rooms</h2>
          <IconButton
            label="Create room"
            className="md-side__add"
            onClick={() => openModal('create-room')}
          >
            <Plus size={16} />
          </IconButton>
        </div>

        <div className="md-side__section">
          {rooms.length === 0 ? (
            <button
              type="button"
              className="md-side__empty"
              onClick={() => openModal('create-room')}
            >
              <Layers size={16} />
              <span>No rooms yet — create your first one.</span>
            </button>
          ) : (
            <ul className="md-roomlist">
              {rooms.map((room) => (
                <li key={room.id}>
                  <RoomRow
                    room={room}
                    active={room.id === activeRoomId}
                    onOpen={() => navigate({ kind: 'room', roomId: room.id })}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="md-side__divider" />

        <div className="md-side__head md-side__head--tight">
          <h2 className="md-eyebrow">Room chat</h2>
        </div>

        <div className="md-side__recent">
          {recent.length === 0 ? (
            <p className="md-side__hint">
              Messages from your rooms appear here. Open a room to start talking.
            </p>
          ) : (
            recent.map((message) => {
              const room = rooms.find((item) => item.id === message.scopeId);
              return (
                <button
                  key={message.id}
                  type="button"
                  className="md-recent"
                  onClick={() =>
                    room ? navigate({ kind: 'room', roomId: room.id }) : undefined
                  }
                >
                  <Avatar name={message.authorName} size={30} />
                  <span className="md-recent__body">
                    <span className="md-recent__meta">
                      <span className="md-recent__name">{message.authorName}</span>
                      <span className="md-recent__time">{clockTime(message.createdAt)}</span>
                    </span>
                    <span className="md-recent__text">{message.body}</span>
                    {room ? <span className="md-recent__room">#{room.name}</span> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <ConnectionBadge />

      <VoiceCard
        profile={profile}
        lastActivity={rooms[0] ? relativeTime(rooms[0].lastActiveAt) : null}
      />
    </aside>
  );
}

function ConnectionBadge() {
  const status = useNetwork((state) => state.status);
  const user = useNetwork((state) => state.user);
  if (status === 'signed-out' || !user) return null;

  const label =
    status === 'online'
      ? `@${user.username} · Connected`
      : status === 'reconnecting'
        ? 'Reconnecting…'
        : status === 'connecting'
          ? 'Connecting…'
          : 'Offline';

  return (
    <div className="md-connection" data-state={status} title="Meldrift server connection">
      <span className="md-connection__dot" aria-hidden="true" />
      <span className="md-connection__label">{label}</span>
    </div>
  );
}

function RoomRow({
  room,
  active,
  onOpen,
}: {
  room: Room;
  active: boolean;
  onOpen: () => void;
}) {
  const accent = colorFor(room.id);
  const isGame = room.kind === 'game';
  return (
    <button type="button" className="md-roomrow" data-active={active} onClick={onOpen}>
      <span
        className="md-roomrow__tile"
        style={vars({ '--tile-a': accent })}
        aria-hidden="true"
      >
        {isGame ? <Gamepad2 size={19} /> : <Headphones size={19} />}
      </span>
      <span className="md-roomrow__body">
        <span className="md-roomrow__name">{room.name}</span>
        <span className="md-roomrow__meta">
          {isGame ? room.gameTitle ?? 'Game room' : 'Voice room'}
        </span>
      </span>
      {active ? <span className="md-roomrow__dot" aria-hidden="true" /> : null}
    </button>
  );
}
