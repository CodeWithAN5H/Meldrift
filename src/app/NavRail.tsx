import {
  Crown,
  Gamepad2,
  House,
  Layers,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { MeldriftMark } from '@/icons/MeldriftMark';
import { useUi, type View } from '@/state/ui';

interface NavEntry {
  id: string;
  label: string;
  icon: typeof House;
  view: View;
  match: Array<View['kind']>;
}

const ENTRIES: NavEntry[] = [
  { id: 'home', label: 'Home', icon: House, view: { kind: 'home' }, match: ['home'] },
  {
    id: 'friends',
    label: 'Friends',
    icon: Users,
    view: { kind: 'friends' },
    match: ['friends'],
  },
  { id: 'rooms', label: 'Rooms', icon: Layers, view: { kind: 'rooms' }, match: ['rooms', 'room'] },
  { id: 'games', label: 'Games', icon: Gamepad2, view: { kind: 'games' }, match: ['games'] },
  {
    id: 'settings',
    label: 'Settings',
    icon: SettingsIcon,
    view: { kind: 'settings' },
    match: ['settings'],
  },
];

export function NavRail() {
  const view = useUi((state) => state.view);
  const navigate = useUi((state) => state.navigate);

  return (
    <div className="md-rail-col">
      <div className="md-brand">
        <MeldriftMark size={27} />
        <span className="md-brand__word">Meldrift</span>
      </div>

      <nav className="md-nav" aria-label="Primary navigation">
        {ENTRIES.map((entry) => {
          const active = entry.match.includes(view.kind);
          const Icon = entry.icon;
          return (
            <button
              key={entry.id}
              type="button"
              className="md-nav__item"
              data-active={active}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(entry.view)}
            >
              <span className="md-nav__glyph">
                <Icon size={20} strokeWidth={1.85} />
              </span>
              <span className="md-nav__label">{entry.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="md-rail__footer">
        <span className="md-rail__glow" aria-hidden="true" />
        <Crown size={17} className="md-rail__crown" />
        <p className="md-rail__title">Meldrift</p>
        <p className="md-rail__sub">
          Forever Free <span aria-hidden="true">♥</span>
        </p>
      </div>
    </div>
  );
}
