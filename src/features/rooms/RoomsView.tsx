import { Copy, Gamepad2, Headphones, Layers, LogIn, Plus, Trash2, Users } from 'lucide-react';
import { useWorkspace } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useUi } from '@/state/ui';
import { Button, EmptyState, IconButton, Pill } from '@/components/ui';
import { colorFor, vars } from '@/lib/model';
import { copyText } from '@/lib/clipboard';
import { clockTime, relativeTime } from '@/lib/format';
import './rooms.css';

export function RoomsView() {
  const rooms = useWorkspace((state) => state.rooms);
  const online = useNetwork((state) => state.status === 'online');
  const serverUrl = useNetwork((state) => state.serverUrl);
  const members = useNetwork((state) => state.members);
  const navigate = useUi((state) => state.navigate);
  const openModal = useUi((state) => state.openModal);
  const pushToast = useUi((state) => state.pushToast);

  const copy = async (code: string) => {
    const ok = await copyText(code);
    pushToast(ok ? 'Invite code copied' : 'Could not copy invite code', ok ? 'success' : 'error');
  };

  return (
    <div className="md-page">
      <header className="md-page__head">
        <div>
          <p className="md-eyebrow">Rooms</p>
          <h1 className="md-page__title">Your rooms</h1>
          <p className="md-page__sub">
            Chat, voice and game sessions live together in a room.
          </p>
        </div>
        <div className="md-page__actions">
          <Button icon={<LogIn size={15} />} onClick={() => openModal('join-room')}>
            Join with code
          </Button>
          <Button icon={<Plus size={15} />} variant="primary" onClick={() => openModal('create-room')}>
            New room
          </Button>
        </div>
      </header>

      <div className="md-note">
        {online ? (
          <>
            <strong>Rooms are live on {serverUrl}.</strong> Share a room's seven-character
            invite code and whoever has it joins this member list and chat.
          </>
        ) : (
          <>
            <strong>Rooms are stored on this PC.</strong> Sign in from Settings → Account
            to create rooms on a server and join a friend's room with their invite code.
          </>
        )}
      </div>

      {rooms.length === 0 ? (
        <div className="md-card">
          <EmptyState
            icon={<Layers size={20} />}
            title="No rooms yet"
            text="Create a room for a game you are playing, or a voice room for a group call."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => openModal('create-room')}>
                Create your first room
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="md-roomtable">
          {rooms.map((room) => (
            <li key={room.id}>
              <div className="md-roomtable__row">
                <span
                  className="md-roomtable__tile"
                  style={vars({ '--tile-a': colorFor(room.id) })}
                  aria-hidden="true"
                >
                  {room.kind === 'game' ? <Gamepad2 size={19} /> : <Headphones size={19} />}
                </span>

                <div className="md-roomtable__info">
                  <p className="md-roomtable__name">
                    {room.name}
                    {room.isOwned ? <Pill tone="accent">Host</Pill> : null}
                  </p>
                  <p className="md-roomtable__meta">
                    <Users size={11} />
                    {(() => {
                      const count = online ? members[room.id]?.length ?? 1 : 1;
                      return `${count} ${count === 1 ? 'member' : 'members'}`;
                    })()}
                    <span aria-hidden="true">·</span>
                    {room.kind === 'game' ? room.gameTitle ?? 'Game room' : 'Voice room'}
                    <span aria-hidden="true">·</span>
                    created {relativeTime(room.createdAt)}
                  </p>
                </div>

                <div className="md-roomtable__code">
                  <span className="md-eyebrow">Invite</span>
                  <button type="button" onClick={() => void copy(room.inviteCode)}>
                    {room.inviteCode}
                    <Copy size={12} />
                  </button>
                </div>

                <div className="md-roomtable__actions">
                  <Button
                    size="sm"
                    onClick={() => navigate({ kind: 'room', roomId: room.id })}
                  >
                    Open
                  </Button>
                  {room.isOwned ? (
                    <IconButton
                      label={`Delete ${room.name}`}
                      tone="danger"
                      onClick={() => openModal('delete-room', { roomId: room.id })}
                    >
                      <Trash2 size={15} />
                    </IconButton>
                  ) : null}
                </div>
              </div>
              <p className="md-roomtable__stamp">Last activity {clockTime(room.lastActiveAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
