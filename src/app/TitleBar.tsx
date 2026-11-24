import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Search, Square, Copy, X } from 'lucide-react';
import { isTauri } from '@/lib/ipc';
import { useUi } from '@/state/ui';
import { Kbd } from '@/components/ui';

/* Windows chrome: our own drag strip, our own caption buttons. The native
   frame is disabled in tauri.conf.json so the app keeps one continuous
   graphite surface, matching the permanent design. */

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const setPaletteOpen = useUi((state) => state.setPaletteOpen);

  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized).catch(() => undefined);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized).catch(() => undefined);
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const call = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    void win[action]().catch(() => undefined);
  };

  return (
    <header className="md-titlebar" data-tauri-drag-region>
      <div className="md-titlebar__spacer" data-tauri-drag-region />

      <button
        type="button"
        className="md-search"
        aria-label="Search rooms, friends and games"
        onClick={() => setPaletteOpen(true)}
      >
        <Search size={15} className="md-search__icon" />
        <span className="md-search__placeholder">Search anything...</span>
        <span className="md-search__kbd">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="md-titlebar__right" data-tauri-drag-region>
        <div className="md-caption">
          <button
            type="button"
            className="md-caption__btn"
            aria-label="Minimize"
            onClick={() => call('minimize')}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            className="md-caption__btn"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => call('toggleMaximize')}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {maximized ? <Copy size={12.5} /> : <Square size={12.5} />}
          </button>
          <button
            type="button"
            className="md-caption__btn md-caption__btn--close"
            aria-label="Close"
            onClick={() => call('close')}
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
