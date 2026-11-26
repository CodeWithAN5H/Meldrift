import { describe, expect, it } from 'vitest';
import {
  exeName,
  isGameRunning,
  roomForGame,
  roomNameForGame,
  windowsForGame,
} from '../src/lib/games';
import type { ControlTarget } from '../src/lib/control/desktop';
import type { Game, Room } from '../src/lib/model';

const game: Game = {
  id: 'game-1',
  title: 'Red Dead Redemption 2',
  exePath: 'D:\\Games\\RDR2\\RDR2.exe',
  accent: '#7c4df2',
  lastPlayedAt: null,
  createdAt: 1,
};

function target(overrides: Partial<ControlTarget>): ControlTarget {
  return {
    id: '1',
    title: 'Window',
    process: 'RDR2.exe',
    minimized: false,
    ...overrides,
  };
}

describe('game library', () => {
  it('reads the executable name from either slash style', () => {
    expect(exeName('D:\\Games\\RDR2\\RDR2.exe')).toBe('RDR2.exe');
    expect(exeName('D:/Games/RDR2/RDR2.exe')).toBe('RDR2.exe');
    expect(exeName('   ')).toBe('');
  });

  it('matches running windows by process name, not by title', () => {
    const targets = [
      target({ id: '1', title: 'Red Dead Redemption 2', process: 'rdr2.exe' }),
      target({ id: '2', title: 'Launcher', process: 'RDR2.exe' }),
      target({ id: '3', title: 'RDR2.exe readme', process: 'notepad.exe' }),
    ];
    expect(windowsForGame(game, targets).map((item) => item.id)).toEqual(['1', '2']);
    expect(isGameRunning(game, targets)).toBe(true);
  });

  it('treats a game with no executable path as not running', () => {
    const noPath = { ...game, exePath: '' };
    expect(windowsForGame(noPath, [target({})])).toEqual([]);
    expect(isGameRunning(noPath, [target({})])).toBe(false);
  });

  it('finds only an owned game room with the same title', () => {
    const rooms: Room[] = [
      {
        id: 'room-1',
        name: 'RDR2 night',
        kind: 'game',
        gameTitle: 'red dead redemption 2',
        inviteCode: 'AAAAAAA',
        isOwned: false,
        createdAt: 1,
        lastActiveAt: 1,
      },
      {
        id: 'room-2',
        name: 'RDR2 night',
        kind: 'game',
        gameTitle: 'Red Dead Redemption 2',
        inviteCode: 'BBBBBBB',
        isOwned: true,
        createdAt: 1,
        lastActiveAt: 1,
      },
    ];
    expect(roomForGame(rooms, game)?.id).toBe('room-2');
    expect(roomForGame(rooms, { ...game, title: 'Other' })).toBeNull();
  });

  it('keeps the generated room name within the 40-character limit', () => {
    const long = { ...game, title: 'A'.repeat(60) };
    expect(roomNameForGame(long).length).toBeLessThanOrEqual(40);
    expect(roomNameForGame(game)).toBe('Red Dead Redemption 2 room');
  });
});
