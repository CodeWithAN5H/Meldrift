import { AudioLines, MicOff, Radio } from 'lucide-react';
import { Avatar, IconButton } from '@/components/ui';
import { useUi } from '@/state/ui';
import { useVoice } from '@/state/voice';
import { useWorkspace } from '@/state/workspace';
import type { Profile } from '@/lib/model';
import { MicLevel } from './MicLevel';

/**
 * Sidebar voice panel. It reports the real local capture state — never a
 * simulated "connected to channel" status, because the voice service that
 * joins peers lands in milestone M3.
 */
export function VoiceCard({
  profile,
  lastActivity,
}: {
  profile: Profile | null;
  lastActivity: string | null;
}) {
  const capturing = useVoice((state) => state.capturing);
  const micEnabled = useVoice((state) => state.micEnabled);
  const inputs = useVoice((state) => state.inputs);
  const setMicEnabled = useVoice((state) => state.setMicEnabled);
  const stop = useVoice((state) => state.stop);
  const openModal = useUi((state) => state.openModal);
  const settings = useWorkspace((state) => state.settings);

  const deviceLabel =
    inputs.find((device) => device.deviceId === settings.micDeviceId)?.label ||
    inputs[0]?.label ||
    'System default microphone';

  return (
    <div className="md-voicecard" data-live={capturing && micEnabled}>
      <div className="md-voicecard__head">
        <span className="md-voicecard__status">
          {capturing ? (
            <Radio size={13} className="md-voicecard__signal" />
          ) : (
            <MicOff size={13} className="md-voicecard__signal" />
          )}
          <span data-muted={capturing && !micEnabled}>
            {capturing
              ? micEnabled
                ? 'Microphone live'
                : 'Microphone muted'
              : 'Voice not connected'}
          </span>
        </span>
        <IconButton
          label="Microphone settings"
          onClick={() => openModal('mic-test')}
          className="md-voicecard__gear"
        >
          <AudioLines size={15} />
        </IconButton>
      </div>

      {capturing ? (
        <div className="md-voicecard__meter">
          <MicLevel />
        </div>
      ) : (
        <p className="md-voicecard__caption">
          Mic check is local only. Voice transmission arrives in M3.
        </p>
      )}

      <div className="md-voicecard__row">
        <Avatar
          name={profile?.displayName ?? 'You'}
          color={profile?.avatarColor}
          size={32}
        />
        <div className="md-voicecard__who">
          <span className="md-voicecard__name">{profile?.displayName ?? 'You'}</span>
          <span className="md-voicecard__device" title={deviceLabel}>
            {deviceLabel}
          </span>
        </div>
        <button
          type="button"
          className="md-voicecard__action"
          onClick={() => {
            if (capturing) {
              void stop();
            } else {
              openModal('mic-test');
            }
          }}
        >
          {capturing ? 'Stop' : 'Test'}
        </button>
      </div>

      <div className="md-voicecard__foot">
        <button type="button" onClick={() => openModal('mic-test')}>
          Mic check
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => setMicEnabled(!micEnabled)}
          disabled={!capturing}
          title={capturing ? undefined : 'Start a mic check first'}
        >
          {micEnabled ? 'Mute' : 'Unmute'}
        </button>
        <span aria-hidden="true">·</span>
        <span className="md-voicecard__activity">
          {lastActivity ? `Active ${lastActivity}` : 'No activity yet'}
        </span>
      </div>
    </div>
  );
}
