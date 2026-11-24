import { useEffect } from 'react';
import { AlertTriangle, Mic, Square } from 'lucide-react';
import { Button, Field, Modal, Slider, Switch } from '@/components/ui';
import { useWorkspace } from '@/state/workspace';
import { useVoice } from '@/state/voice';
import { voiceEngine } from '@/lib/voice';
import { MicLevel } from '@/features/voice/MicLevel';

export function MicTestModal({ onClose }: { onClose: () => void }) {
  const settings = useWorkspace((state) => state.settings);
  const updateSettings = useWorkspace((state) => state.updateSettings);
  const inputs = useVoice((state) => state.inputs);
  const capturing = useVoice((state) => state.capturing);
  const starting = useVoice((state) => state.starting);
  const error = useVoice((state) => state.error);
  const refreshInputs = useVoice((state) => state.refreshInputs);
  const start = useVoice((state) => state.start);
  const stop = useVoice((state) => state.stop);

  useEffect(() => {
    void refreshInputs();
  }, [refreshInputs]);

  const begin = async () => {
    await start({
      deviceId: settings.micDeviceId,
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
      inputVolume: settings.inputVolume,
    });
  };

  return (
    <Modal
      title="Microphone check"
      subtitle="Local monitoring only — nothing is transmitted yet."
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Field label="Input device" htmlFor="mic-test-device">
        <select
          id="mic-test-device"
          className="md-select"
          value={settings.micDeviceId}
          onChange={(event) => void updateSettings({ micDeviceId: event.target.value })}
        >
          <option value="default">System default</option>
          {inputs.map((device, index) => (
            <option key={device.deviceId || index} value={device.deviceId}>
              {device.label || `Microphone ${index + 1}`}
            </option>
          ))}
        </select>
      </Field>

      <div className="md-micpanel">
        <div className="md-micpanel__head">
          <span className="md-micpanel__state" data-live={capturing}>
            {capturing ? 'Listening' : starting ? 'Starting…' : 'Microphone off'}
          </span>
          <Button
            size="sm"
            variant={capturing ? 'default' : 'primary'}
            icon={capturing ? <Square size={12} /> : <Mic size={13} />}
            onClick={() => (capturing ? void stop() : void begin())}
          >
            {capturing ? 'Stop' : 'Start test'}
          </Button>
        </div>
        <MicLevel />
        {error ? (
          <p className="md-error">
            <AlertTriangle size={13} />
            {error}
          </p>
        ) : (
          <p className="md-hint">
            Speak normally — the bar should move with your voice. Adjust input level if
            it clips.
          </p>
        )}
      </div>

      <Field label="Input level">
        <div className="md-inline">
          <Slider
            min={0}
            max={200}
            value={settings.inputVolume}
            aria-label="Input level"
            onValueChange={(value) => {
              voiceEngine.setGain(value);
              void updateSettings({ inputVolume: value });
            }}
          />
          <span className="md-value">{settings.inputVolume}%</span>
        </div>
      </Field>

      <div className="md-togglelist">
        <div className="md-togglelist__row">
          <span>Noise suppression</span>
          <Switch
            label="Noise suppression"
            checked={settings.noiseSuppression}
            onChange={(next) => void updateSettings({ noiseSuppression: next })}
          />
        </div>
        <div className="md-togglelist__row">
          <span>Echo cancellation</span>
          <Switch
            label="Echo cancellation"
            checked={settings.echoCancellation}
            onChange={(next) => void updateSettings({ echoCancellation: next })}
          />
        </div>
        <div className="md-togglelist__row">
          <span>Automatic gain</span>
          <Switch
            label="Automatic gain control"
            checked={settings.autoGainControl}
            onChange={(next) => void updateSettings({ autoGainControl: next })}
          />
        </div>
      </div>

      <p className="md-hint">
        Device changes apply the next time the microphone starts. Voice channels and
        peer audio arrive in M3.
      </p>
    </Modal>
  );
}
