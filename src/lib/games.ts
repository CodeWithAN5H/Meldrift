import type { ControlTarget } from './control/desktop';
import type { Game, Room } from './model';

/* --------------------------------------------------------------------------
   Game library helpers.

   A saved game stores the executable path the user chose. The Windows app can
   already enumerate real top-level windows for remote control, so the library
   uses that same list to answer "is this game running?" — no second process
   scanner and no invented status.

   Capture itself stays with WebView2's display picker: the list can point at a
   running window, but Meldrift cannot silently select a capture surface.
   -------------------------------------------------------------------------- */

/** The executable file name (no directories), or '' when no path is set. */
export function exeName(exePath: string): string {
  const trimmed = exePath.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * Windows window titles and process names are case-insensitive, and a game may
 * own several windows (launcher, game, overlay). All are returned.
 */
export function windowsForGame(game: Game, targets: ControlTarget[]): ControlTarget[] {
  const name = exeName(game.exePath).toLowerCase();
  if (!name) return [];
  return targets.filter((target) => target.process.toLowerCase() === name);
}

export function isGameRunning(game: Game, targets: ControlTarget[]): boolean {
  return windowsForGame(game, targets).length > 0;
}

/** The owned room already set up for this game, if there is one. */
export function roomForGame(rooms: Room[], game: Game): Room | null {
  const title = game.title.trim().toLowerCase();
  if (!title) return null;
  return (
    rooms.find(
      (room) =>
        room.isOwned &&
        room.kind === 'game' &&
        (room.gameTitle ?? '').trim().toLowerCase() === title,
    ) ?? null
  );
}

/** A room name derived from the game title, kept inside the server's limit. */
export function roomNameForGame(game: Game): string {
  const base = game.title.trim().slice(0, 33) || 'Game';
  return `${base} room`.slice(0, 40);
}
