import { beforeEach, describe, expect, it } from 'vitest';
import { webPort } from '../src/lib/ipc';
import { makeProfile } from '../src/lib/model';

/* The browser adapter shares the same contract as the SQLite adapter, so these
   tests pin the semantics both must honour (scoping, validation, cascades). */

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

beforeEach(async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
  await webPort.clearWorkspace();
  await webPort.saveProfile(makeProfile('Ansh'));
});

describe('workspace port', () => {
  it('creates rooms with unique invite codes and a single owner', async () => {
    const first = await webPort.createRoom({ name: 'The Boys', kind: 'game', gameTitle: 'RDR2' });
    const second = await webPort.createRoom({ name: 'Chill', kind: 'voice', gameTitle: null });

    expect(first.inviteCode).not.toBe(second.inviteCode);
    expect(first.isOwned).toBe(true);
    expect(first.gameTitle).toBe('RDR2');
    expect(second.gameTitle).toBeNull();
  });

  it('persists messages within their scope only', async () => {
    const room = await webPort.createRoom({ name: 'Squad', kind: 'game', gameTitle: null });
    const friend = await webPort.addFriend({ displayName: 'Rohan', handle: 'rohan' });

    await webPort.sendMessage({ scopeType: 'room', scopeId: room.id, body: 'ready?' });
    await webPort.sendMessage({ scopeType: 'dm', scopeId: friend.id, body: 'join us' });

    expect((await webPort.listMessages('room', room.id)).map((m) => m.body)).toEqual(['ready?']);
    expect((await webPort.listMessages('dm', friend.id)).map((m) => m.body)).toEqual(['join us']);
  });

  it('rejects empty messages', async () => {
    const room = await webPort.createRoom({ name: 'Squad', kind: 'game', gameTitle: null });
    await expect(
      webPort.sendMessage({ scopeType: 'room', scopeId: room.id, body: '   ' }),
    ).rejects.toThrow();
  });

  it('updates a room name without touching its game', async () => {
    const room = await webPort.createRoom({ name: 'Squad', kind: 'game', gameTitle: 'RDR2' });
    const updated = await webPort.updateRoom({
      id: room.id,
      name: 'Night Squad',
      gameTitle: room.gameTitle,
    });
    expect(updated.name).toBe('Night Squad');
    expect(updated.gameTitle).toBe('RDR2');
  });

  it('deletes a room together with its messages', async () => {
    const room = await webPort.createRoom({ name: 'Temp', kind: 'game', gameTitle: null });
    await webPort.sendMessage({ scopeType: 'room', scopeId: room.id, body: 'hello' });
    await webPort.deleteRoom(room.id);

    const data = await webPort.bootstrap();
    expect(data.rooms).toHaveLength(0);
    expect(data.messages).toHaveLength(0);
  });

  it('clears everything on request', async () => {
    await webPort.createRoom({ name: 'Temp', kind: 'voice', gameTitle: null });
    await webPort.addFriend({ displayName: 'Aman', handle: 'aman' });
    await webPort.addGame({ title: 'RDR2', exePath: '' });
    await webPort.clearWorkspace();

    const data = await webPort.bootstrap();
    expect(data.profile).toBeNull();
    expect(data.rooms).toHaveLength(0);
    expect(data.friends).toHaveLength(0);
    expect(data.games).toHaveLength(0);
  });
});
