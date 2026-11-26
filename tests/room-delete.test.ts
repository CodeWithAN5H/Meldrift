import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setRemoteAdapter, type RemoteAdapter } from '../src/lib/net/hub';
import type { Room } from '../src/lib/model';
import { useUi } from '../src/state/ui';
import { useWorkspace } from '../src/state/workspace';

const room: Room = {
  id: 'room-1',
  name: 'The Boys',
  kind: 'game',
  gameTitle: 'RDR2',
  inviteCode: 'K7M2QX9',
  isOwned: true,
  createdAt: 1,
  lastActiveAt: 2,
};

function adapter(deleteRoom: RemoteAdapter['deleteRoom']): RemoteAdapter {
  return {
    serverUrl: 'http://127.0.0.1:8787',
    userId: 'user-1',
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    deleteRoom,
    loadMessages: vi.fn(),
    sendMessage: vi.fn(),
    removeFriend: vi.fn(),
  } as unknown as RemoteAdapter;
}

beforeEach(() => {
  // The toast store schedules its own dismissal on `window`; this suite runs in
  // Node, where that global does not exist.
  vi.stubGlobal('window', { setTimeout: () => 0 });
  setRemoteAdapter(null);
  useUi.setState({ toasts: [] });
  useWorkspace.setState({
    ready: true,
    rooms: [room],
    messages: {
      'room:room-1': [
        {
          id: 'm1',
          scopeType: 'room',
          scopeId: 'room-1',
          authorId: 'user-1',
          authorName: 'Player One',
          body: 'hello',
          createdAt: 2,
        },
      ],
    },
  });
});

describe('room deletion store', () => {
  it('removes the room only after the server confirms it', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    setRemoteAdapter(adapter(remove));

    const deleted = await useWorkspace.getState().deleteRoom('room-1');

    expect(deleted).toBe(true);
    expect(remove).toHaveBeenCalledWith('room-1');
    expect(useWorkspace.getState().rooms).toEqual([]);
    expect(useWorkspace.getState().messages['room:room-1']).toBeUndefined();
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('keeps the room and reports the real error when the server refuses', async () => {
    setRemoteAdapter(
      adapter(vi.fn().mockRejectedValue(new Error('Only the room host can delete this room'))),
    );

    const deleted = await useWorkspace.getState().deleteRoom('room-1');

    expect(deleted).toBe(false);
    expect(useWorkspace.getState().rooms).toHaveLength(1);
    expect(useWorkspace.getState().messages['room:room-1']).toHaveLength(1);
    const toasts = useUi.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].tone).toBe('error');
    expect(toasts[0].message).toBe('Only the room host can delete this room');
    expect(toasts.some((toast) => toast.message === 'Room deleted')).toBe(false);
  });

  it('keeps the room when the server cannot be reached', async () => {
    setRemoteAdapter(
      adapter(vi.fn().mockRejectedValue(new Error('Cannot reach http://127.0.0.1:8787.'))),
    );

    const deleted = await useWorkspace.getState().deleteRoom('room-1');

    expect(deleted).toBe(false);
    expect(useWorkspace.getState().rooms).toHaveLength(1);
    expect(useUi.getState().toasts[0].tone).toBe('error');
  });

  it('drops a room another host deleted, including its cached messages', () => {
    useWorkspace.getState().removeRemoteRoom('room-1');
    expect(useWorkspace.getState().rooms).toEqual([]);
    expect(useWorkspace.getState().messages['room:room-1']).toBeUndefined();
  });
});
