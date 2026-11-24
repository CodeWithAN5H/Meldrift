import type { FriendView, MessageView, PublicUser, RoomMemberView, RoomView } from '@shared/protocol';
import type { Friend, Message, Profile, Room } from '@/lib/model';

/* Pure translations between the wire protocol and the UI model. Keeping them
   pure makes the mapping testable and keeps stores free of shape juggling. */

export function toProfile(user: PublicUser): Profile {
  return {
    id: user.id,
    displayName: user.displayName,
    handle: user.username,
    avatarColor: user.avatarColor,
    bio: '',
    createdAt: Date.now(),
  };
}

export function toRoom(view: RoomView, viewerId: string): Room {
  return {
    id: view.id,
    name: view.name,
    kind: view.kind,
    gameTitle: view.gameTitle,
    inviteCode: view.inviteCode,
    isOwned: view.ownerId === viewerId,
    createdAt: view.createdAt,
    lastActiveAt: view.lastActiveAt,
  };
}

export function toFriend(view: FriendView): Friend {
  return {
    id: view.userId,
    displayName: view.displayName,
    handle: view.username,
    presence: view.presence,
    note: '',
    createdAt: view.since,
  };
}

export function toMessage(view: MessageView, scopeId = view.scopeId): Message {
  return {
    id: view.id,
    scopeType: view.scopeType,
    scopeId,
    authorId: view.authorId,
    authorName: view.authorName,
    body: view.body,
    createdAt: view.createdAt,
  };
}

export function memberCount(members: RoomMemberView[] | undefined): number {
  return members?.length ?? 1;
}

/** Deduplicates by id so a reconnect or a re-fetch cannot double-post. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((message) => message.id));
  const merged = [...existing];
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  merged.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return merged;
}
