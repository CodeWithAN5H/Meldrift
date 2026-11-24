import { describe, expect, it } from 'vitest';
import { normalizeServerUrl, websocketUrl } from '@/lib/net/api';
import { mergeMessages, toFriend, toMessage, toRoom } from '@/lib/net/map';
import type { Message } from '@/lib/model';

describe('server addresses', () => {
  it('accepts bare host and port', () => {
    expect(normalizeServerUrl('localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeServerUrl('  127.0.0.1:8787  ')).toBe('http://127.0.0.1:8787');
  });

  it('keeps https and strips trailing slashes but not a path prefix', () => {
    expect(normalizeServerUrl('https://voice.example.com/')).toBe('https://voice.example.com');
    expect(normalizeServerUrl('https://example.com/meldrift/')).toBe(
      'https://example.com/meldrift',
    );
  });

  it('rejects empty and non-http addresses', () => {
    expect(() => normalizeServerUrl('   ')).toThrow();
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow();
  });

  it('derives the socket URL and carries the token', () => {
    expect(websocketUrl('http://127.0.0.1:8787', 'abc 123')).toBe(
      'ws://127.0.0.1:8787/ws?token=abc+123',
    );
    expect(websocketUrl('https://example.com', 'abc')).toBe('wss://example.com/ws?token=abc');
  });
});

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'createdAt'>): Message {
  return {
    scopeType: 'room',
    scopeId: 'room-1',
    authorId: 'user-1',
    authorName: 'Ansh',
    body: 'hello',
    ...overrides,
  };
}

describe('message merging', () => {
  it('deduplicates by id and keeps chronological order', () => {
    const first = message({ id: 'b', createdAt: 200 });
    const second = message({ id: 'a', createdAt: 100 });
    const merged = mergeMessages([first], [second, first]);
    expect(merged.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('returns the same list when there is nothing new', () => {
    const existing = [message({ id: 'a', createdAt: 1 })];
    expect(mergeMessages(existing, [])).toBe(existing);
  });
});

describe('wire mapping', () => {
  it('marks a room as owned only for its owner', () => {
    const view = {
      id: 'room-1',
      name: 'The Boys',
      kind: 'game' as const,
      gameTitle: 'RDR2',
      inviteCode: 'K7M2QX9',
      ownerId: 'host-1',
      createdAt: 10,
      lastActiveAt: 20,
      members: [],
    };
    expect(toRoom(view, 'host-1').isOwned).toBe(true);
    expect(toRoom(view, 'guest-1').isOwned).toBe(false);
  });

  it('maps friends with their server presence and username handle', () => {
    const friend = toFriend({
      userId: 'u2',
      username: 'rohan',
      displayName: 'Rohan',
      avatarColor: '#3a7bd5',
      presence: 'online',
      since: 5,
    });
    expect(friend).toMatchObject({
      id: 'u2',
      displayName: 'Rohan',
      handle: 'rohan',
      presence: 'online',
    });
  });

  it('can re-scope a DM message to the friend id the UI uses', () => {
    const mapped = toMessage(
      {
        id: 'm1',
        scopeType: 'dm',
        scopeId: 'conversation-1',
        authorId: 'u2',
        authorName: 'Rohan',
        authorAvatarColor: '#3a7bd5',
        body: 'hey',
        createdAt: 7,
      },
      'friend-1',
    );
    expect(mapped.scopeId).toBe('friend-1');
    expect(mapped.scopeType).toBe('dm');
  });
});
