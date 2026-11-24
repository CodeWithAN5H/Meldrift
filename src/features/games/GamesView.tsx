import { FolderOpen, Gamepad2, Plus, Trash2 } from 'lucide-react';
import { useWorkspace } from '@/state/workspace';
import { useUi } from '@/state/ui';
import { Button, EmptyState, IconButton } from '@/components/ui';
import { compactPath, relativeTime } from '@/lib/format';
import { vars } from '@/lib/model';
import './games.css';

export function GamesView() {
  const games = useWorkspace((state) => state.games);
  const openModal = useUi((state) => state.openModal);
  const removeGame = useWorkspace((state) => state.removeGame);

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
        <strong>Capture is not wired yet.</strong> Adding a game stores its title and
        executable path locally. Window capture, streaming and remote control arrive
        in milestones M4 and M5.
      </div>

      {games.length === 0 ? (
        <div className="md-card">
          <EmptyState
            icon={<Gamepad2 size={20} />}
            title="No games added"
            text="Add the game you want to share. The path is only used on this PC to launch and capture it later."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => openModal('add-game')}>
                Add a game
              </Button>
            }
          />
        </div>
      ) : (
        <div className="md-gamegrid">
          {games.map((game) => (
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
                  Added {relativeTime(game.createdAt)}
                  {game.lastPlayedAt ? ` · played ${relativeTime(game.lastPlayedAt)}` : ''}
                </p>
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
          ))}
        </div>
      )}
    </div>
  );
}
