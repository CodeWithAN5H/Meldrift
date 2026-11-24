import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Gamepad2,
  House,
  Layers,
  Search,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useWorkspace } from '@/state/workspace';
import { useUi } from '@/state/ui';
import './palette.css';

interface Result {
  id: string;
  group: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  run: () => void;
}

export function CommandPalette() {
  const open = useUi((state) => state.paletteOpen);
  const query = useUi((state) => state.searchQuery);
  const setQuery = useUi((state) => state.setSearchQuery);
  const setOpen = useUi((state) => state.setPaletteOpen);
  const navigate = useUi((state) => state.navigate);
  const rooms = useWorkspace((state) => state.rooms);
  const friends = useWorkspace((state) => state.friends);
  const games = useWorkspace((state) => state.games);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  const close = () => {
    setQuery('');
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    setActive(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (value: string) => !needle || value.toLowerCase().includes(needle);

    const nav: Result[] = [
      { id: 'nav-home', group: 'Go to', label: 'Home', hint: 'Dashboard', icon: House, run: () => navigate({ kind: 'home' }) },
      { id: 'nav-friends', group: 'Go to', label: 'Friends', hint: 'Friends and DMs', icon: Users, run: () => navigate({ kind: 'friends' }) },
      { id: 'nav-rooms', group: 'Go to', label: 'Rooms', hint: 'Manage rooms', icon: Layers, run: () => navigate({ kind: 'rooms' }) },
      { id: 'nav-games', group: 'Go to', label: 'Games', hint: 'Your library', icon: Gamepad2, run: () => navigate({ kind: 'games' }) },
      { id: 'nav-settings', group: 'Go to', label: 'Settings', hint: 'Preferences', icon: Settings, run: () => navigate({ kind: 'settings' }) },
    ].filter((item) => matches(item.label));

    const roomResults: Result[] = rooms
      .filter((room) => matches(room.name) || matches(room.gameTitle ?? ''))
      .slice(0, 6)
      .map((room) => ({
        id: `room-${room.id}`,
        group: 'Rooms',
        label: room.name,
        hint: `${room.kind === 'game' ? room.gameTitle ?? 'Game room' : 'Voice room'} · ${room.inviteCode}`,
        icon: Layers,
        run: () => navigate({ kind: 'room', roomId: room.id }),
      }));

    const friendResults: Result[] = friends
      .filter((friend) => matches(friend.displayName) || matches(friend.handle))
      .slice(0, 5)
      .map((friend) => ({
        id: `friend-${friend.id}`,
        group: 'Friends',
        label: friend.displayName,
        hint: `@${friend.handle}`,
        icon: Users,
        run: () => navigate({ kind: 'friends', friendId: friend.id }),
      }));

    const gameResults: Result[] = games
      .filter((game) => matches(game.title))
      .slice(0, 4)
      .map((game) => ({
        id: `game-${game.id}`,
        group: 'Games',
        label: game.title,
        hint: 'Open library',
        icon: Gamepad2,
        run: () => navigate({ kind: 'games' }),
      }));

    return [...nav, ...roomResults, ...friendResults, ...gameResults].slice(0, 14);
  }, [friends, games, navigate, query, rooms]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const choose = (result: Result | undefined) => {
    if (!result) return;
    result.run();
    close();
  };

  return createPortal(
    <div
      className="md-palette__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="md-palette" role="dialog" aria-modal="true" aria-label="Search Meldrift">
        <div className="md-palette__field">
          <Search size={16} className="md-palette__icon" />
          <input
            ref={inputRef}
            className="md-palette__input"
            value={query}
            placeholder="Search rooms, friends, games…"
            aria-label="Search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((value) => Math.min(results.length - 1, value + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(results[active]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          />
          <kbd className="md-kbd">Esc</kbd>
        </div>

        <div className="md-palette__list" ref={listRef}>
          {results.length === 0 ? (
            <p className="md-palette__empty">No matches for “{query}”.</p>
          ) : (
            results.map((result, index) => {
              const showGroup = index === 0 || results[index - 1].group !== result.group;
              const Icon = result.icon;
              return (
                <div key={result.id}>
                  {showGroup ? <p className="md-palette__group">{result.group}</p> : null}
                  <button
                    type="button"
                    className="md-palette__row"
                    data-active={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(result)}
                  >
                    <span className="md-palette__rowicon">
                      <Icon size={15} />
                    </span>
                    <span className="md-palette__label">{result.label}</span>
                    <span className="md-palette__hint">{result.hint}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        <footer className="md-palette__foot">
          <span><kbd className="md-kbd">↑</kbd><kbd className="md-kbd">↓</kbd> navigate</span>
          <span><kbd className="md-kbd">Enter</kbd> open</span>
          <span><kbd className="md-kbd">Esc</kbd> close</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
