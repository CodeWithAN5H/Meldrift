import {
  ArrowRight,
  Check,
  ChevronRight,
  Gamepad2,
  Layers,
  Mic,
  Plus,
  Sparkles,
  UserPlus,
  Users,
} from 'lucide-react';
import { useWorkspace } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useUi } from '@/state/ui';
import { useVoice } from '@/state/voice';
import { Avatar, Button, EmptyState } from '@/components/ui';
import { greeting } from '@/lib/format';
import { RoomCard } from '@/features/rooms/RoomCard';
import './home.css';

export function HomeView() {
  const profile = useWorkspace((state) => state.profile);
  const rooms = useWorkspace((state) => state.rooms);
  const friends = useWorkspace((state) => state.friends);
  const games = useWorkspace((state) => state.games);
  const capturing = useVoice((state) => state.capturing);
  const online = useNetwork((state) => state.status === 'online');
  const navigate = useUi((state) => state.navigate);
  const openModal = useUi((state) => state.openModal);

  const firstName = (profile?.displayName ?? 'player').split(' ')[0];
  const onlineFriends = friends.filter((friend) => friend.presence === 'online').length;

  return (
    <div className="md-page">
      <header className="md-page__head">
        <div>
          <p className="md-eyebrow">Meldrift</p>
          <h1 className="md-page__title">
            {greeting()}, {firstName}
          </h1>
          <p className="md-page__sub">Your game. Everyone's turn.</p>
        </div>
        <div className="md-page__actions">
          <Button icon={<UserPlus size={15} />} onClick={() => openModal('add-friend')}>
            Add friend
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => openModal('create-room')}
          >
            Create room
          </Button>
        </div>
      </header>

      <section className="md-stats" aria-label="Workspace summary">
        <StatCard icon={<Layers size={16} />} value={rooms.length} label="Rooms" />
        <StatCard
          icon={<Users size={16} />}
          value={friends.length}
          label="Friends"
          detail={friends.length ? `${onlineFriends} online` : 'None yet'}
        />
        <StatCard icon={<Gamepad2 size={16} />} value={games.length} label="Games" />
        <StatCard
          icon={<Mic size={16} />}
          value={capturing ? 'Live' : 'Idle'}
          label="Microphone"
          detail={capturing ? 'Local monitor' : 'Not capturing'}
          tone={capturing ? 'green' : undefined}
        />
      </section>

      {rooms.length === 0 ? (
        <section className="md-card md-home__start">
          <div className="md-home__start-head">
            <span className="md-empty__icon">
              <Sparkles size={19} />
            </span>
            <div>
              <h2 className="md-home__start-title">Set up your first room</h2>
              <p className="md-home__start-text">
                {online
                  ? 'Rooms hold your chat, voice and game sessions. Yours live on your server, so friends on other PCs can join with an invite code.'
                  : 'Rooms hold your chat, voice and game sessions. They stay on this PC until you sign in from Account settings.'}
              </p>
            </div>
          </div>
          <ol className="md-steps">
            <li className="md-step" data-done={Boolean(profile)}>
              <span className="md-step__mark">
                <Check size={11} />
              </span>
              <span className="md-step__body">
                <span className="md-step__title">Create your profile</span>
                <span className="md-step__hint">Name and avatar colour are saved locally.</span>
              </span>
            </li>
            <li className="md-step" data-done={rooms.length > 0}>
              <span className="md-step__mark">
                <Check size={11} />
              </span>
              <span className="md-step__body">
                <span className="md-step__title">Create a room</span>
                <span className="md-step__hint">Pick a game room or a voice room.</span>
              </span>
              <Button size="sm" variant="primary" onClick={() => openModal('create-room')}>
                Create
              </Button>
            </li>
            <li className="md-step" data-done={capturing}>
              <span className="md-step__mark">
                <Check size={11} />
              </span>
              <span className="md-step__body">
                <span className="md-step__title">Check your microphone</span>
                <span className="md-step__hint">Device, gain and level metering.</span>
              </span>
              <Button size="sm" onClick={() => openModal('mic-test')}>
                Test
              </Button>
            </li>
          </ol>
        </section>
      ) : null}

      <section className="md-home__section">
        <div className="md-home__sectionhead">
          <h2 className="md-home__sectiontitle">Your rooms</h2>
          <button
            type="button"
            className="md-link"
            onClick={() => navigate({ kind: 'rooms' })}
          >
            See all <ChevronRight size={13} />
          </button>
        </div>
        {rooms.length === 0 ? (
          <div className="md-card">
            <EmptyState
              icon={<Layers size={20} />}
              title="No rooms yet"
              text="A room is where friends gather to talk, watch and play."
              action={
                <Button variant="primary" onClick={() => openModal('create-room')}>
                  Create a room
                </Button>
              }
            />
          </div>
        ) : (
          <div className="md-roomgrid">
            {rooms.slice(0, 4).map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                onOpen={() => navigate({ kind: 'room', roomId: room.id })}
              />
            ))}
          </div>
        )}
      </section>

      <section className="md-home__section">
        <div className="md-home__sectionhead">
          <h2 className="md-home__sectiontitle">Friends</h2>
          <button
            type="button"
            className="md-link"
            onClick={() => navigate({ kind: 'friends' })}
          >
            Open friends <ChevronRight size={13} />
          </button>
        </div>
        <div className="md-card md-friendstrip">
          {friends.length === 0 ? (
            <div className="md-friendstrip__empty">
              <p className="md-friendstrip__text">
                Add a friend to keep their DM and invitations in one place.
              </p>
              <Button size="sm" icon={<UserPlus size={14} />} onClick={() => openModal('add-friend')}>
                Add friend
              </Button>
            </div>
          ) : (
            friends.slice(0, 6).map((friend) => (
              <button
                key={friend.id}
                type="button"
                className="md-friendchip"
                onClick={() => navigate({ kind: 'friends', friendId: friend.id })}
              >
                <Avatar name={friend.displayName} size={36} presence={friend.presence} />
                <span className="md-friendchip__name">{friend.displayName}</span>
                <ArrowRight size={13} className="md-friendchip__arrow" />
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function StatCard({
  icon,
  value,
  label,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  detail?: string;
  tone?: 'green';
}) {
  return (
    <div className="md-stat" data-tone={tone}>
      <span className="md-stat__icon">{icon}</span>
      <div className="md-stat__text">
        <p className="md-stat__value">{value}</p>
        <p className="md-stat__label">{label}</p>
      </div>
      {detail ? <span className="md-stat__detail">{detail}</span> : null}
    </div>
  );
}
