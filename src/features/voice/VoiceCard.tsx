import { AudioLines, MicOff, Radio } from 'lucide-react';
import { Avatar, IconButton } from '@/components/ui';
import { useUi } from '@/state/ui';
import { useVoice } from '@/state/voice';
import { useVoiceRoom } from '@/state/voiceRoom';
import { useWorkspace } from '@/state/workspace';
import type { Profile } from '@/lib/model';
import { MicLevel } from './MicLevel';

/**
 * Sidebar voice panel. It reports the real local capture state and, while a
 * room voice session is active, the real mesh state from `voiceRoom` — never a
 * simulated "connected to channel" status.
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
  const inVoice = useVoiceRoom((state) => Boolean(state.roomId));
  const voiceRoomName = useVoiceRoom((state) => state.roomName);
  const voiceMuted = useVoiceRoom((state) => state.muted);
  const voiceStatus = useVoiceRoom((state) => state.status);
  const voicePeers = useVoiceRoom((state) => Object.keys(state.participants).length);
  const toggleVoiceMuted = useVoiceRoom((state) => state.toggleMuted);
  const leaveVoice = useVoiceRoom((state) => state.leave);

  const deviceLabel =
    inputs.find((device) => device.deviceId === settings.micDeviceId)?.label ||
    inputs[0]?.label ||
    'System default microphone';

  const voiceLabel = inVoice
    ? voiceStatus === 'connected'
      ? `In voice \u00b7 ${voiceRoomName ?? 'Room'}`
      : voiceStatus === 'reconnecting'
        ? 'Voice reconnecting\u2026'
        : voiceStatus === 'error'
          ? 'Voice failed'
          : 'Connecting voice\u2026'
    : capturing
      ? micEnabled
        ? 'Microphone live'
        : 'Microphone muted'
      : 'Voice not connected';

  return (
    <div className="md-voicecard" data-live={inVoice ? voiceStatus === 'connected' : capturing && micEnabled}>
      <div className="md-voicecard__head">
        <span className="md-voicecard__status">
          {inVoice || capturing ? (
            <Radio size={13} className="md-voicecard__signal" />
          ) : (
            <MicOff size={13} className="md-voicecard__signal" />
          )}
          <span data-muted={inVoice ? voiceMuted : capturing && !micEnabled}>
            {voiceLabel}
            {inVoice && voiceStatus === 'connected'
              ? ` \u00b7 ${voicePeers + 1} in channel`
              : ''}
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
          Mic check is local. Join a room's voice channel to talk with its members.
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
            if (inVoice) {
              leaveVoice();
            } else if (capturing) {
              void stop();
            } else {
              openModal('mic-test');
            }
          }}
        >
          {inVoice ? 'Leave' : capturing ? 'Stop' : 'Test'}
        </button>
      </div>

      <div className="md-voicecard__foot">
        <button type="button" onClick={() => openModal('mic-test')}>
          Mic check
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => (inVoice ? toggleVoiceMuted() : setMicEnabled(!micEnabled))}
          disabled={!inVoice && !capturing}
          title={!inVoice && !capturing ? 'Start a mic check first' : undefined}
        >
          {(inVoice ? voiceMuted : !micEnabled) ? 'Unmute' : 'Mute'}
        </button>
        <span aria-hidden="true">·</span>
        <span className="md-voicecard__activity">
          {lastActivity ? `Active ${lastActivity}` : 'No activity yet'}
        </span>
      </div>
    </div>
  );
}
