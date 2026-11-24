import { useMemo, useState } from 'react';
import { Check, MessageSquare, Search, Trash2, UserPlus, Users, X } from 'lucide-react';
import { useWorkspace } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useUi } from '@/state/ui';
import { Avatar, Button, EmptyState, IconButton } from '@/components/ui';
import { VirtualList } from '@/components/VirtualList';
import { ChatThread } from '@/features/chat/ChatThread';
import type { Friend } from '@/lib/model';
import './friends.css';

export function FriendsView({ friendId }: { friendId: string | null }) {
  const friends = useWorkspace((state) => state.friends);
  const online = useNetwork((state) => state.status === 'online');
  const requests = useNetwork((state) => state.requests);
  const acceptRequest = useNetwork((state) => state.acceptRequest);
  const declineRequest = useNetwork((state) => state.declineRequest);
  const navigate = useUi((state) => state.navigate);
  const openModal = useUi((state) => state.openModal);
  const [tab, setTab] = useState<'all' | 'online'>('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return friends.filter((friend) => {
      if (tab === 'online' && friend.presence !== 'online') return false;
      if (!needle) return true;
      return (
        friend.displayName.toLowerCase().includes(needle) ||
        friend.handle.toLowerCase().includes(needle)
      );
    });
  }, [friends, query, tab]);

  const selected = friends.find((friend) => friend.id === friendId) ?? null;
  const onlineCount = friends.filter((friend) => friend.presence === 'online').length;

  return (
    <div className="md-friends">
      <section className="md-card md-friends__list" aria-label="Friends">
        <div className="md-friends__head">
          <h1 className="md-page__title md-friends__title">Friends</h1>
          <IconButton label="Add friend" onClick={() => openModal('add-friend')}>
            <UserPlus size={16} />
          </IconButton>
        </div>

        <div className="md-tabs md-friends__tabs">
          <button
            type="button"
            className="md-tab"
            data-active={tab === 'all'}
            onClick={() => setTab('all')}
          >
            All<span className="md-tab__count">{friends.length}</span>
          </button>
          <button
            type="button"
            className="md-tab"
            data-active={tab === 'online'}
            onClick={() => setTab('online')}
          >
            Online<span className="md-tab__count">{onlineCount}</span>
          </button>
        </div>

        <div className="md-friends__search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search friends"
            aria-label="Search friends"
          />
        </div>

        {requests.length > 0 ? (
          <div className="md-requests" aria-label="Friend requests">
            <p className="md-eyebrow">Requests ({requests.length})</p>
            {requests.map((request) => (
              <div key={request.userId} className="md-request">
                <Avatar name={request.displayName} color={request.avatarColor} size={30} />
                <span className="md-request__body">
                  <span className="md-request__name">{request.displayName}</span>
                  <span className="md-request__handle">@{request.username}</span>
                </span>
                <IconButton
                  label={`Accept ${request.displayName}`}
                  onClick={() => void acceptRequest(request.userId)}
                >
                  <Check size={15} />
                </IconButton>
                <IconButton
                  label={`Decline ${request.displayName}`}
                  tone="danger"
                  onClick={() => void declineRequest(request.userId)}
                >
                  <X size={15} />
                </IconButton>
              </div>
            ))}
          </div>
        ) : null}

        <div className="md-friends__scroll">
          {filtered.length === 0 ? (
            <EmptyState
              icon={<Users size={19} />}
              title={friends.length === 0 ? 'No friends yet' : 'Nothing matches'}
              text={
                friends.length === 0
                  ? 'Add someone to keep your direct messages together.'
                  : 'Try another name or handle.'
              }
              compact
              action={
                friends.length === 0 ? (
                  <Button size="sm" onClick={() => openModal('add-friend')}>
                    Add friend
                  </Button>
                ) : null
              }
            />
          ) : (
            <VirtualList
              items={filtered}
              itemHeight={56}
              gap={2}
              keyOf={(friend) => friend.id}
              renderItem={(friend) => (
                <FriendRow
                  friend={friend}
                  active={friend.id === friendId}
                  onOpen={() => navigate({ kind: 'friends', friendId: friend.id })}
                />
              )}
            />
          )}
        </div>

        <p className="md-friends__note">
          {online
            ? 'Presence is live from your server. Only friends can see it.'
            : 'Signed out: friends are local contacts and presence is not reported.'}
        </p>
      </section>

      <section className="md-card md-friends__pane" aria-label="Direct messages">
        {selected ? (
          <DirectMessage friend={selected} />
        ) : (
          <EmptyState
            icon={<MessageSquare size={20} />}
            title="Pick a conversation"
            text={
              online
                ? 'Messages go through your server, so both of you see them.'
                : 'Direct messages stay on this PC until you sign in.'
            }
          />
        )}
      </section>
    </div>
  );
}

function FriendRow({
  friend,
  active,
  onOpen,
}: {
  friend: Friend;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="md-friendrow"
      data-active={active}
      onClick={onOpen}
    >
      <Avatar name={friend.displayName} size={36} presence={friend.presence} />
      <span className="md-friendrow__body">
        <span className="md-friendrow__name">{friend.displayName}</span>
        <span className="md-friendrow__handle">@{friend.handle}</span>
      </span>
      <span className="md-friendrow__presence" data-state={friend.presence}>
        {friend.presence === 'online' ? 'Online' : 'Offline'}
      </span>
    </button>
  );
}

function DirectMessage({ friend }: { friend: Friend }) {
  const openModal = useUi((state) => state.openModal);
  const online = useNetwork((state) => state.status === 'online');
  return (
    <>
      <header className="md-dm__head">
        <Avatar name={friend.displayName} size={38} presence={friend.presence} />
        <div className="md-dm__who">
          <p className="md-dm__name">{friend.displayName}</p>
          <p className="md-dm__meta">
            @{friend.handle}
            <span className="md-dm__dot" aria-hidden="true" />
            {friend.presence === 'online' ? 'Online' : 'Offline'}
          </p>
        </div>
        <IconButton
          label="Remove friend"
          tone="danger"
          onClick={() => openModal('remove-friend', { friendId: friend.id })}
        >
          <Trash2 size={15} />
        </IconButton>
      </header>
      <ChatThread
        scopeType="dm"
        scopeId={friend.id}
        placeholder={`Message ${friend.displayName}`}
        emptyTitle={`This is the start of your DM with ${friend.displayName}`}
        emptyText={
          online
            ? 'Send the first message — it is delivered through your server.'
            : 'Messages are saved on this PC. Sign in from Account settings to deliver them.'
        }
      />
    </>
  );
}
