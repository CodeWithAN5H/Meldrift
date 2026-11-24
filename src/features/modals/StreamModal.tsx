import { useState } from 'react';
import { Monitor, MonitorUp, Square, TriangleAlert } from 'lucide-react';
import type { StreamMode, StreamPreset } from '@shared/protocol';
import { Button, Field, Modal } from '@/components/ui';
import {
  STREAM_PRESET_ORDER,
  STREAM_PRESET_SPECS,
  modeLabel,
} from '@/lib/stream/model';
import { useStreamRoom } from '@/state/streamRoom';
import { useControlRoom } from '@/state/controlRoom';

/**
 * Host setup. The Start button is the user gesture that opens WebView2's
 * screen/window picker; cancelling it leaves an existing stream untouched.
 */
export function StreamModal({
  roomId,
  initialMode,
  onClose,
}: {
  roomId: string;
  initialMode?: StreamMode;
  onClose: () => void;
}) {
  const hosting = useStreamRoom((state) => state.hosting);
  const activeMode = useStreamRoom((state) => state.mode);
  const activePreset = useStreamRoom((state) => state.preset);
  const startHosting = useStreamRoom((state) => state.startHosting);
  const switchSource = useStreamRoom((state) => state.switchSource);
  const error = useStreamRoom((state) => state.error);

  const [mode, setMode] = useState<StreamMode>(
    hosting ? activeMode : (initialMode ?? 'window'),
  );
  const [preset, setPreset] = useState<StreamPreset>(hosting ? activePreset : 'auto');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    if (hosting) {
      // A different capture source means a different consent boundary.
      useControlRoom.getState().revoke('The host changed the shared window.');
    }
    const ok = hosting
      ? await switchSource({ roomId, mode, preset })
      : await startHosting({ roomId, mode, preset });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      title={hosting ? 'Change capture source' : 'Share your screen'}
      subtitle={
        hosting
          ? 'Pick another window or display. The current stream keeps running until the new source is chosen.'
          : 'Windows will list your open windows and displays. Only the surface you pick is captured.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Opening picker…' : hosting ? 'Switch source' : 'Start streaming'}
          </Button>
        </>
      }
    >
      <Field label="What to share">
        <div className="md-segment">
          <button
            type="button"
            className="md-segment__item"
            data-active={mode === 'window'}
            onClick={() => setMode('window')}
          >
            <MonitorUp size={15} />
            {modeLabel('window')}
          </button>
          <button
            type="button"
            className="md-segment__item"
            data-active={mode === 'desktop'}
            onClick={() => setMode('desktop')}
          >
            <Monitor size={15} />
            {modeLabel('desktop')}
          </button>
        </div>
      </Field>

      {mode === 'window' ? (
        <p className="md-hint">
          The picker lists real window titles. Choose the game window you want the
          room to see; other windows and the desktop are not captured.
        </p>
      ) : (
        <p className="md-note md-note--warn">
          <TriangleAlert size={13} />
          The entire selected display will be visible, including notifications and
          anything else on that screen. Use window capture if you want to keep the
          rest of the desktop private.
        </p>
      )}

      <Field label="Quality preset" hint={STREAM_PRESET_SPECS[preset].summary}>
        <select
          className="md-select"
          value={preset}
          onChange={(event) => setPreset(event.target.value as StreamPreset)}
        >
          {STREAM_PRESET_ORDER.map((item) => (
            <option key={item} value={item}>
              {STREAM_PRESET_SPECS[item].label}
            </option>
          ))}
        </select>
      </Field>

      <div className="md-note">
        <Square size={12} />
        Up to 4 viewers per room. Each viewer receives its own video stream, so
        your upload grows with the number of people watching. Voice stays
        connected while you stream.
      </div>

      {error ? <p className="md-note md-note--error">{error}</p> : null}
    </Modal>
  );
}
