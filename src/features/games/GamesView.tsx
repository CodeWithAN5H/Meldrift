import { useEffect, useState } from 'react';
import { FolderOpen, Gamepad2, Play, Plus, Share2, Trash2 } from 'lucide-react';
import { useWorkspace } from '@/state/workspace';
import { useUi } from '@/state/ui';
import { Button, EmptyState, IconButton, Pill } from '@/components/ui';
import { compactPath, relativeTime } from '@/lib/format';
import { vars, type Game } from '@/lib/model';
import { controlDesktop, type ControlTarget } from '@/lib/control/desktop';
import { roomForGame, roomNameForGame, windowsForGame } from '@/lib/games';
import './games.css';

/* The library is the entry point into the M4/M5 pipeline: a real room, real
   window streaming, real consent-based control. Capture itself stays with
   WebView2's picker, so "Share" opens that picker instead of pretending a
   window can be captured without the host choosing it. */

const TARGET_REFRESH_MS = 5_000;

export function GamesView() {
  const games = useWorkspace((state) => state.games);
  const rooms = useWorkspace((state) => state.rooms);
  const createRoom = useWorkspace((state) => state.createRoom);
  const launchGame = useWorkspace((state) => state.launchGame);
  const removeGame = useWorkspace((state) => state.removeGame);
  const openModal = useUi((state) => state.openModal);
  const navigate = useUi((state) => state.navigate);
  const [targets, setTargets] = useState<ControlTarget[]>([]);
  const desktop = controlDesktop.available();

  // The window list already exists for remote control. Reuse it to report real
  // running state instead of adding a second process scanner.
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    const refresh = async () => {
      try {
        const list = await controlDesktop.targets();
        if (alive) setTargets(list);
      } catch {
        // The native layer is unavailable; cards simply show "Not running".
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), TARGET_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [desktop]);

  const share = async (game: Game) => {
    const existing = roomForGame(rooms, game);
    const room =
      existing ??
      (await createRoom({
        name: roomNameForGame(game),
        kind: 'game',
        gameTitle: game.title,
      }));
    if (!room) return;
    navigate({ kind: 'room', roomId: room.id });
    openModal('stream', { roomId: room.id, mode: 'window' });
  };

  return (
    <div className="md-page">
      <header className="md-page__head">
        <div>
          <p className="md-eyebrow">Games</p>
          <h1 className="md-page__title">Your library</h1>
          <p className="md-page__sub">
            Keep the games you share with friends in one place.
          </p>
        </div>
        <div className="md-page__actions">
          <Button icon={<Plus size={15} />} variant="primary" onClick={() => openModal('add-game')}>
            Add game
          </Button>
        </div>
      </header>

      <div className="md-note">
        <strong>Share opens a game room.</strong> Meldrift opens Windows&apos; own
        window picker so you choose exactly what is captured. Room members can then
        watch live, and with your consent one of them can take remote control.
        Ctrl+Alt+F12 stops control immediately.
      </div>

      {games.length === 0 ? (
        <div className="md-card">
          <EmptyState
            icon={<Gamepad2 size={20} />}
            title="No games added"
            text="Add the game you want to share. The path is only used on this PC to launch it and help Meldrift recognise its window."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => openModal('add-game')}>
                Add a game
              </Button>
            }
          />
        </div>
      ) : (
        <div className="md-gamegrid">
          {games.map((game) => {
            const windows = windowsForGame(game, targets);
            const running = windows.length > 0;
            return (
              <article key={game.id} className="md-gamecard" style={vars({ '--tile-a': game.accent })}>
                <div className="md-gamecard__art" aria-hidden="true">
                  <Gamepad2 size={26} />
                </div>
                <div className="md-gamecard__body">
                  <h3 className="md-gamecard__title">{game.title}</h3>
                  <p className="md-gamecard__path" title={game.exePath || 'No path set'}>
                    <FolderOpen size={11} />
                    {game.exePath ? compactPath(game.exePath) : 'No executable set'}
                  </p>
                  <p className="md-gamecard__meta">
                    {running ? (
                      <Pill tone="accent">Running</Pill>
                    ) : (
                      <span>{desktop ? 'Not running' : 'Window detection needs the desktop app'}</span>
                    )}
                    {game.lastPlayedAt ? ` · launched ${relativeTime(game.lastPlayedAt)}` : ''}
                  </p>
                  {windows.length > 0 ? (
                    <p className="md-gamecard__meta" title={windows.map((item) => item.title).join('\n')}>
                      Window: {windows[0].title}
                      {windows.length > 1 ? ` +${windows.length - 1} more` : ''}
                    </p>
                  ) : null}
                  <div className="md-gamecard__actions">
                    {game.exePath && !running ? (
                      <Button
                        size="sm"
                        icon={<Play size={13} />}
                        disabled={!desktop}
                        title={desktop ? 'Start this executable' : 'Launching needs the Windows app'}
                        onClick={() => void launchGame(game.id)}
                      >
                        Launch
                      </Button>
                    ) : null}
                    <Button size="sm" icon={<Share2 size={13} />} onClick={() => void share(game)}>
                      {roomForGame(rooms, game) ? 'Open room' : 'Start room'}
                    </Button>
                  </div>
                </div>
                <IconButton
                  label={`Remove ${game.title}`}
                  tone="danger"
                  className="md-gamecard__remove"
                  onClick={() => void removeGame(game.id)}
                >
                  <Trash2 size={14} />
                </IconButton>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
