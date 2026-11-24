import {
  Copy,
  Crown,
  Eye,
  Gamepad2,
  Headphones,
  ListOrdered,
  Mic,
  MicOff,
  ShieldCheck,
  VolumeX,
} from 'lucide-react';
import { useRoom, useWorkspace } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useUi } from '@/state/ui';
import { useVoice } from '@/state/voice';
import { useVoiceRoom } from '@/state/voiceRoom';
import { Avatar, IconButton } from '@/components/ui';
import { describeConnection } from '@/lib/voice/model';
import { copyText } from '@/lib/clipboard';
import './room.css';

const EMPTY_PARTICIPANTS: Record<string, never> = {};

export function ContextPanel({ roomId }: { roomId: string }) {
  const room = useRoom(roomId);
  const profile = useWorkspace((state) => state.profile);
  const settings = useWorkspace((state) => state.settings);
  const capturing = useVoice((state) => state.capturing);
  const micEnabled = useVoice((state) => state.micEnabled);
  const pushToast = useUi((state) => state.pushToast);
  const online = useNetwork((state) => state.status === 'online');
  const remoteMembers = useNetwork((state) => state.members[roomId]);
  const members = online && remoteMembers && remoteMembers.length > 0 ? remoteMembers : null;

  const inVoice = useVoiceRoom((state) => state.roomId === roomId);
  const voiceStatus = useVoiceRoom((state) => (state.roomId === roomId ? state.status : 'idle'));
  const voiceMuted = useVoiceRoom((state) => (state.roomId === roomId ? state.muted : false));
  const voiceDeafened = useVoiceRoom((state) =>
    state.roomId === roomId ? state.deafened : false,
  );
  const voiceSpeaking = useVoiceRoom((state) => (state.roomId === roomId ? state.speaking : false));
  const voiceParticipants = useVoiceRoom((state) =>
    state.roomId === roomId ? state.participants : EMPTY_PARTICIPANTS,
  );
  const joinVoice = useVoiceRoom((state) => state.join);
  const leaveVoice = useVoiceRoom((state) => state.leave);

  if (!room || !profile) return null;

  const voiceRows = inVoice
    ? [
        {
          userId: profile.id,
          displayName: profile.displayName,
          avatarColor: profile.avatarColor,
          muted: voiceMuted,
          deafened: voiceDeafened,
          speaking: voiceSpeaking,
          connection: 'connected' as const,
          you: true,
        },
        ...Object.values(voiceParticipants).map((participant) => ({
          userId: participant.userId,
          displayName: participant.displayName,
          avatarColor: participant.avatarColor,
          muted: participant.muted,
          deafened: participant.deafened,
          speaking: participant.audible || participant.speaking,
          connection: participant.connection,
          you: false,
        })),
      ]
    : [];

  const copyInvite = async () => {
    const ok = await copyText(room.inviteCode);
    pushToast(ok ? 'Invite code copied' : 'Could not copy code', ok ? 'success' : 'error');
  };

  return (
    <aside className="md-context" aria-label="Room details">
      <section className="md-card md-context__card">
        <header className="md-context__head">
          <h2 className="md-eyebrow">
            Room members ({members ? members.length : 1})
          </h2>
          <IconButton label="Copy invite code" onClick={() => void copyInvite()}>
            <Copy size={14} />
          </IconButton>
        </header>

        {members ? (
          members.map((member) => (
            <div className="md-member" key={member.userId}>
              <Avatar
                name={member.displayName}
                color={member.avatarColor}
                size={34}
                presence={member.presence}
              />
              <div className="md-member__body">
                <p className="md-member__name">
                  {member.displayName}
                  {member.role === 'host' ? <Crown size={11} className="md-member__crown" /> : null}
                </p>
                <p className="md-member__meta">
                  {member.role === 'host' ? 'Host' : 'Member'}
                  {member.userId === profile.id ? ' · You' : ''}
                </p>
              </div>
              {member.userId === profile.id ? (
                <Mic
                  size={14}
                  className="md-member__mic"
                  data-on={capturing && micEnabled}
                  aria-label={capturing && micEnabled ? 'Microphone on' : 'Microphone off'}
                />
              ) : null}
            </div>
          ))
        ) : (
          <>
            <div className="md-member">
              <Avatar
                name={profile.displayName}
                color={profile.avatarColor}
                size={34}
                presence="offline"
              />
              <div className="md-member__body">
                <p className="md-member__name">{profile.displayName}</p>
                <p className="md-member__meta">Local room · Not on a server</p>
              </div>
              <Mic
                size={14}
                className="md-member__mic"
                data-on={capturing && micEnabled}
                aria-label={capturing && micEnabled ? 'Microphone on' : 'Microphone off'}
              />
            </div>
            <p className="md-context__note">
              This room lives on this PC. Sign in from Account settings to have friends
              join it.
            </p>
          </>
        )}
      </section>

      <section className="md-card md-context__card">
        <header className="md-context__head">
          <h2 className="md-eyebrow">Voice ({voiceRows.length})</h2>
          {inVoice ? (
            <button type="button" className="md-context__clear" onClick={() => leaveVoice()}>
              Leave
            </button>
          ) : (
            <button
              type="button"
              className="md-context__clear"
              disabled={!members}
              title={members ? 'Join the voice channel' : 'Voice needs a server room'}
              onClick={() => void joinVoice(room.id)}
            >
              Join
            </button>
          )}
        </header>

        {voiceRows.length === 0 ? (
          <p className="md-context__empty">
            <Headphones size={14} />
            No one is in voice. Join to talk with this room.
          </p>
        ) : (
          <ul className="md-voicepeople">
            {voiceRows.map((row) => (
              <li
                key={row.userId}
                className="md-voiceperson"
                data-speaking={row.speaking && !row.muted}
              >
                <span className="md-voiceperson__avatar">
                  <Avatar name={row.displayName} color={row.avatarColor} size={30} />
                </span>
                <span className="md-voiceperson__body">
                  <span className="md-voiceperson__name">
                    {row.displayName}
                    {row.you ? ' \u00b7 You' : ''}
                  </span>
                  <span className="md-voiceperson__meta">
                    {row.speaking && !row.muted
                      ? 'Speaking'
                      : row.muted
                        ? describeConnection(row.connection) === 'Connected'
                          ? 'Muted'
                          : `${describeConnection(row.connection)} \u00b7 Muted`
                        : describeConnection(row.connection)}
                    {row.deafened ? ' \u00b7 Deafened' : ''}
                  </span>
                </span>
                <span className="md-voiceperson__icons">
                  {row.muted ? (
                    <MicOff size={13} aria-label="Muted" />
                  ) : (
                    <Mic size={13} aria-label="Microphone on" />
                  )}
                  {row.deafened ? <VolumeX size={13} aria-label="Deafened" /> : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="md-context__foot">
          <ShieldCheck size={12} />
          {inVoice
            ? voiceStatus === 'connected'
              ? 'Peer-to-peer Opus audio · encrypted with DTLS-SRTP'
              : `Voice ${voiceStatus === 'reconnecting' ? 'reconnecting' : 'connecting'}`
            : 'Server-checked membership · Opus voice'}
        </p>
      </section>

      <section className="md-spectate">
        <span className="md-spectate__icon">
          <Gamepad2 size={20} />
        </span>
        <h3 className="md-spectate__title">
          {room.isOwned ? "You're hosting" : "You're watching"}
        </h3>
        <p className="md-spectate__text">
          {room.isOwned
            ? 'Share your game and you decide who gets control, and when to take it back.'
            : 'The host can hand control to anyone in the room.'}
        </p>
        <span className="md-spectate__tag">
          <Eye size={11} /> Spectators never send input
        </span>
      </section>

      <section className="md-card md-context__card">
        <header className="md-context__head">
          <h2 className="md-eyebrow">Player queue (0)</h2>
          <button type="button" className="md-context__clear" disabled title="No control session is active">
            Clear
          </button>
        </header>
        <p className="md-context__empty">
          <ListOrdered size={14} />
          No one is waiting. The queue opens when a session starts.
        </p>
      </section>

      <section className="md-card md-context__card">
        <header className="md-context__head">
          <h2 className="md-eyebrow">Session</h2>
        </header>
        <dl className="md-context__rows">
          <div>
            <dt>Status</dt>
            <dd>Idle</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{settings.controlMode === 'single' ? 'Single player' : 'Multi controller'}</dd>
          </div>
          <div>
            <dt>Quality</dt>
            <dd>
              {settings.streamHeight}p · {settings.streamFps} fps
            </dd>
          </div>
          <div>
            <dt>Invite</dt>
            <dd className="md-context__code">{room.inviteCode}</dd>
          </div>
        </dl>
        <p className="md-context__foot">
          <ShieldCheck size={12} />
          Host approval required for every controller
        </p>
      </section>
    </aside>
  );
}
