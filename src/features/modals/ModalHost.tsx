import { useState } from 'react';
import { Gamepad2, Headphones, Trash2 } from 'lucide-react';
import { useUi } from '@/state/ui';
import { useNetwork } from '@/state/network';
import { useWorkspace } from '@/state/workspace';
import { Button, Field, Modal } from '@/components/ui';
import { MicTestModal } from './MicTestModal';
import { StreamModal } from './StreamModal';
import './modals.css';

export function ModalHost() {
  const modal = useUi((state) => state.modal);
  const payload = useUi((state) => state.modalPayload);
  const closeModal = useUi((state) => state.closeModal);

  switch (modal) {
    case 'create-room':
      return <CreateRoomModal onClose={closeModal} />;
    case 'join-room':
      return <JoinRoomModal onClose={closeModal} />;
    case 'add-friend':
      return <AddFriendModal onClose={closeModal} />;
    case 'add-game':
      return <AddGameModal onClose={closeModal} />;
    case 'mic-test':
      return <MicTestModal onClose={closeModal} />;
    case 'delete-room':
      return <DeleteRoomModal roomId={payload?.roomId ?? ''} onClose={closeModal} />;
    case 'remove-friend':
      return <RemoveFriendModal friendId={payload?.friendId ?? ''} onClose={closeModal} />;
    case 'clear-data':
      return <ClearDataModal onClose={closeModal} />;
    case 'stream':
      return (
        <StreamModal
          roomId={payload?.roomId ?? ''}
          initialMode={payload?.mode === 'desktop' ? 'desktop' : 'window'}
          onClose={closeModal}
        />
      );
    default:
      return null;
  }
}

function CreateRoomModal({ onClose }: { onClose: () => void }) {
  const createRoom = useWorkspace((state) => state.createRoom);
  const games = useWorkspace((state) => state.games);
  const navigate = useUi((state) => state.navigate);
  const pushToast = useUi((state) => state.pushToast);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'game' | 'voice'>('game');
  const [gameTitle, setGameTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const room = await createRoom({
      name: name.trim() || (kind === 'game' ? 'New game room' : 'New voice room'),
      kind,
      gameTitle: kind === 'game' ? gameTitle.trim() || null : null,
    });
    setBusy(false);
    if (room) {
      pushToast(`Room "${room.name}" created`, 'success');
      onClose();
      navigate({ kind: 'room', roomId: room.id });
    }
  };

  return (
    <Modal
      title="Create a room"
      subtitle="Chat, voice and game sessions live together here."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            Create room
          </Button>
        </>
      }
    >
      <Field label="Room name" htmlFor="room-name-input">
        <input
          id="room-name-input"
          className="md-input"
          value={name}
          maxLength={40}
          placeholder="The Boys"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </Field>

      <Field label="Room type">
        <div className="md-segment">
          <button
            type="button"
            className="md-segment__item"
            data-active={kind === 'game'}
            onClick={() => setKind('game')}
          >
            <Gamepad2 size={15} />
            Game room
          </button>
          <button
            type="button"
            className="md-segment__item"
            data-active={kind === 'voice'}
            onClick={() => setKind('voice')}
          >
            <Headphones size={15} />
            Voice room
          </button>
        </div>
      </Field>

      {kind === 'game' ? (
        <Field
          label="Game title"
          htmlFor="room-game-input"
          hint="Optional. You can also change this later in the room's Game info tab."
        >
          <input
            id="room-game-input"
            className="md-input"
            value={gameTitle}
            maxLength={60}
            list="md-game-titles"
            placeholder="Red Dead Redemption 2"
            onChange={(event) => setGameTitle(event.target.value)}
          />
          <datalist id="md-game-titles">
            {games.map((game) => (
              <option key={game.id} value={game.title} />
            ))}
          </datalist>
        </Field>
      ) : null}
    </Modal>
  );
}

function JoinRoomModal({ onClose }: { onClose: () => void }) {
  const joinRoom = useWorkspace((state) => state.joinRoom);
  const status = useNetwork((state) => state.status);
  const navigate = useUi((state) => state.navigate);
  const pushToast = useUi((state) => state.pushToast);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const online = status === 'online';

  const submit = async () => {
    if (!online || busy || code.length !== 7) return;
    setBusy(true);
    const room = await joinRoom(code);
    setBusy(false);
    if (room) {
      pushToast(`Joined "${room.name}"`, 'success');
      onClose();
      navigate({ kind: 'room', roomId: room.id });
    }
  };

  return (
    <Modal
      title="Join with an invite code"
      subtitle="Use the code from the host's room panel."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!online || busy || code.length !== 7}
            onClick={() => void submit()}
          >
            {busy ? 'Joining…' : 'Join room'}
          </Button>
        </>
      }
    >
      <Field label="Invite code" htmlFor="join-code" hint="Seven characters, for example K7M2QX9.">
        <input
          id="join-code"
          className="md-input"
          value={code}
          maxLength={7}
          autoFocus
          spellCheck={false}
          placeholder="K7M2QX9"
          onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 7))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </Field>

      {online ? (
        <div className="md-note">
          Joining adds you to the room's member list and chat on your server. You will
          see live presence for everyone in it.
        </div>
      ) : (
        <div className="md-note">
          <strong>Sign in first.</strong> Joining a room by code needs the signaling
          service, so Meldrift knows which room on the server to add you to.
          <div className="md-note__action">
            <Button
              size="sm"
              onClick={() => {
                onClose();
                navigate({ kind: 'settings', section: 'account' });
              }}
            >
              Open account settings
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function AddFriendModal({ onClose }: { onClose: () => void }) {
  const addFriend = useWorkspace((state) => state.addFriend);
  const status = useNetwork((state) => state.status);
  const sendFriendRequest = useNetwork((state) => state.sendFriendRequest);
  const pushToast = useUi((state) => state.pushToast);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = status === 'online';

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);

    if (online) {
      const result = await sendFriendRequest(handle || name);
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? 'The request could not be sent');
        return;
      }
      pushToast(`Friend request sent to @${(handle || name).replace(/^@/, '')}`, 'success');
      onClose();
      return;
    }

    const friend = await addFriend({ displayName: name, handle: handle || name });
    setBusy(false);
    if (friend) {
      pushToast(`${friend.displayName} added as a local contact`, 'success');
      onClose();
    }
  };

  return (
    <Modal
      title={online ? 'Send a friend request' : 'Add a local contact'}
      subtitle={
        online
          ? 'They accept before either of you can message the other.'
          : 'Local contacts keep your direct messages together on this PC.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Working…' : online ? 'Send request' : 'Add contact'}
          </Button>
        </>
      }
    >
      <Field label={online ? 'Username' : 'Name'} htmlFor="friend-name">
        <input
          id="friend-name"
          className="md-input"
          value={name}
          maxLength={32}
          placeholder={online ? 'rohan' : 'Rohan'}
          autoFocus
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </Field>

      {online ? null : (
        <Field label="Handle" htmlFor="friend-handle" hint="Optional. Used for @mentions later.">
          <input
            id="friend-handle"
            className="md-input"
            value={handle}
            maxLength={32}
            placeholder="rohan"
            onChange={(event) => setHandle(event.target.value)}
          />
        </Field>
      )}

      {error ? <p className="md-note md-note--error">{error}</p> : null}

      <div className="md-note">
        {online
          ? 'Requests appear in your friend\'s Friends view. Presence only becomes visible after they accept.'
          : 'Signing in from Settings → Account switches friends to your server, where requests are real. This record stays on this PC.'}
      </div>
    </Modal>
  );
}

function AddGameModal({ onClose }: { onClose: () => void }) {
  const addGame = useWorkspace((state) => state.addGame);
  const pushToast = useUi((state) => state.pushToast);
  const [title, setTitle] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const game = await addGame({ title, exePath: path });
    setBusy(false);
    if (game) {
      pushToast(`${game.title} added to your library`, 'success');
      onClose();
    }
  };

  return (
    <Modal
      title="Add a game"
      subtitle="Stored locally for the capture pipeline."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
            Add game
          </Button>
        </>
      }
    >
      <Field label="Game title" htmlFor="game-title">
        <input
          id="game-title"
          className="md-input"
          value={title}
          maxLength={60}
          placeholder="Red Dead Redemption 2"
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>
      <Field
        label="Executable path"
        htmlFor="game-path"
        hint="Optional. Used on this PC when launching and capturing the game."
      >
        <input
          id="game-path"
          className="md-input"
          value={path}
          maxLength={512}
          placeholder="D:\\Games\\RDR2\\RDR2.exe"
          onChange={(event) => setPath(event.target.value)}
        />
      </Field>
    </Modal>
  );
}

function DeleteRoomModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const rooms = useWorkspace((state) => state.rooms);
  const deleteRoom = useWorkspace((state) => state.deleteRoom);
  const view = useUi((state) => state.view);
  const navigate = useUi((state) => state.navigate);
  const pushToast = useUi((state) => state.pushToast);
  const room = rooms.find((item) => item.id === roomId);

  return (
    <Modal
      title="Delete this room?"
      subtitle={room ? `"${room.name}" and its messages will be removed from this PC.` : 'This room no longer exists.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!room}
            onClick={async () => {
              if (!room) return;
              await deleteRoom(room.id);
              pushToast('Room deleted');
              onClose();
              if (view.kind === 'room' && view.roomId === room.id) navigate({ kind: 'rooms' });
            }}
          >
            <Trash2 size={14} /> Delete room
          </Button>
        </>
      }
    >
      <p className="md-confirm">
        Messages saved in this room are deleted with it. Game records and your friends
        are not affected.
      </p>
    </Modal>
  );
}

function RemoveFriendModal({ friendId, onClose }: { friendId: string; onClose: () => void }) {
  const friends = useWorkspace((state) => state.friends);
  const removeFriend = useWorkspace((state) => state.removeFriend);
  const navigate = useUi((state) => state.navigate);
  const pushToast = useUi((state) => state.pushToast);
  const friend = friends.find((item) => item.id === friendId);

  return (
    <Modal
      title="Remove this friend?"
      subtitle={friend ? `${friend.displayName} and your DM history will be removed.` : undefined}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={!friend}
            onClick={async () => {
              if (!friend) return;
              await removeFriend(friend.id);
              pushToast(`${friend.displayName} removed`);
              onClose();
              navigate({ kind: 'friends' });
            }}
          >
            Remove
          </Button>
        </>
      }
    >
      <p className="md-confirm">This only affects local data on this PC.</p>
    </Modal>
  );
}

function ClearDataModal({ onClose }: { onClose: () => void }) {
  const clearWorkspace = useWorkspace((state) => state.clearWorkspace);
  const pushToast = useUi((state) => state.pushToast);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="Clear all local data?"
      subtitle="This cannot be undone."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await clearWorkspace();
              setBusy(false);
              onClose();
              pushToast('Local data cleared');
            }}
          >
            <Trash2 size={14} /> Clear everything
          </Button>
        </>
      }
    >
      <ul className="md-confirm-list">
        <li>Your profile and settings</li>
        <li>Rooms and their chat history</li>
        <li>Friends and direct messages</li>
        <li>Your game library</li>
      </ul>
      <p className="md-confirm">You will return to the setup screen.</p>
    </Modal>
  );
}

