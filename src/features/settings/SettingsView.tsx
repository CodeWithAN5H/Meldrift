import { useEffect, useState } from 'react';
import {
  AudioLines,
  Database,
  Gamepad2,
  Info,
  Keyboard,
  MonitorPlay,
  Palette,
  RefreshCw,
  Server,
  UserRound,
} from 'lucide-react';
import { useWorkspace } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useUi } from '@/state/ui';
import { useVoice } from '@/state/voice';
import { listAudioOutputs, voiceEngine } from '@/lib/voice';
import { Avatar, Button, Field, Switch, Slider } from '@/components/ui';
import { AVATAR_COLORS, vars } from '@/lib/model';
import { resolutionLabel } from '@/lib/format';
import { STREAM_PRESET_ORDER, STREAM_PRESET_SPECS } from '@/lib/stream/model';
import { APP_VERSION } from '@/lib/version';
import { MicLevel } from '@/features/voice/MicLevel';
import './settings.css';

const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'account', label: 'Account', icon: Server },
  { id: 'audio', label: 'Audio', icon: AudioLines },
  { id: 'streaming', label: 'Streaming', icon: MonitorPlay },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'data', label: 'Local data', icon: Database },
  { id: 'about', label: 'About', icon: Info },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

export function SettingsView({ section }: { section?: string }) {
  const [active, setActive] = useState<SectionId>(
    (SECTIONS.find((item) => item.id === section)?.id ?? 'profile') as SectionId,
  );

  return (
    <div className="md-settings">
      <header className="md-page__head">
        <div>
          <p className="md-eyebrow">Settings</p>
          <h1 className="md-page__title">Preferences</h1>
          <p className="md-page__sub">Preferences are saved on this PC as you change them.</p>
        </div>
      </header>

      <div className="md-settings__body">
        <nav className="md-settings__nav" aria-label="Settings sections">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className="md-settings__navitem"
                data-active={active === item.id}
                onClick={() => setActive(item.id)}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="md-settings__panel md-card md-scroll">
          {active === 'profile' ? <ProfileSection /> : null}
          {active === 'account' ? <AccountSection /> : null}
          {active === 'audio' ? <AudioSection /> : null}
          {active === 'streaming' ? <StreamingSection /> : null}
          {active === 'appearance' ? <AppearanceSection /> : null}
          {active === 'data' ? <DataSection /> : null}
          {active === 'about' ? <AboutSection /> : null}
        </div>
      </div>
    </div>
  );
}

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="md-setrow">
      <div className="md-setrow__text">
        <p className="md-setrow__title">{title}</p>
        {hint ? <p className="md-setrow__hint">{hint}</p> : null}
      </div>
      <div className="md-setrow__control">{children}</div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="md-setgroup">
      <h2 className="md-section-title">{title}</h2>
      <div className="md-setgroup__body">{children}</div>
    </section>
  );
}

/* ---- Account ----------------------------------------------------------- */

const STATUS_TEXT: Record<string, string> = {
  'signed-out': 'Not connected',
  connecting: 'Connecting…',
  online: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Server unreachable',
};

function AccountSection() {
  const status = useNetwork((state) => state.status);
  const user = useNetwork((state) => state.user);
  const busy = useNetwork((state) => state.busy);
  const error = useNetwork((state) => state.error);
  const currentServer = useNetwork((state) => state.serverUrl);
  const signIn = useNetwork((state) => state.signIn);
  const signUp = useNetwork((state) => state.signUp);
  const signOut = useNetwork((state) => state.signOut);
  const retry = useNetwork((state) => state.retry);
  const pushToast = useUi((state) => state.pushToast);

  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [serverUrl, setServerUrl] = useState(currentServer || 'http://127.0.0.1:8787');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const signedIn = Boolean(user) && status !== 'signed-out';

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    setFormError(null);
    const result =
      mode === 'signin'
        ? await signIn({ serverUrl, username, password })
        : await signUp({ serverUrl, username, password, displayName });
    if (result.ok) {
      pushToast(mode === 'signin' ? 'Signed in' : 'Account created', 'success');
      setPassword('');
    } else {
      setFormError(result.error ?? 'Could not reach the server');
    }
  };

  return (
    <>
      <Group title="Connection">
        <Row
          title="Status"
          hint={signedIn && currentServer ? currentServer : 'Local mode — nothing leaves this PC.'}
        >
          <span className="md-status" data-state={status}>
            <span className="md-status__dot" aria-hidden="true" />
            {STATUS_TEXT[status] ?? status}
          </span>
        </Row>
        {signedIn && user ? (
          <Row title="Signed in as" hint={`@${user.username}`}>
            <div className="md-account__actions">
              {status !== 'online' ? (
                <Button onClick={retry}>Reconnect</Button>
              ) : null}
              <Button variant="danger" onClick={() => void signOut()} disabled={busy}>
                Sign out
              </Button>
            </div>
          </Row>
        ) : null}
      </Group>

      {error && !signedIn ? (
        <p className="md-note md-note--error">{error}</p>
      ) : null}

      {!signedIn ? (
        <>
          <Group title="Your server">
            <Field
              label="Signaling server"
              htmlFor="account-server"
              hint="The address of the Meldrift service you or a friend runs. Default port is 8787."
            >
              <input
                id="account-server"
                className="md-input"
                value={serverUrl}
                placeholder="https://voice.example.com"
                spellCheck={false}
                onChange={(event) => setServerUrl(event.target.value)}
              />
            </Field>
          </Group>

          <Group title={mode === 'signin' ? 'Sign in' : 'Create an account'}>
            <div className="md-segment md-account__tabs">
              <button
                type="button"
                className="md-segment__item"
                data-active={mode === 'signin'}
                onClick={() => setMode('signin')}
              >
                Sign in
              </button>
              <button
                type="button"
                className="md-segment__item"
                data-active={mode === 'signup'}
                onClick={() => setMode('signup')}
              >
                Create account
              </button>
            </div>

            <Field
              label="Username"
              htmlFor="account-username"
              hint="3–24 letters, numbers or underscores."
            >
              <input
                id="account-username"
                className="md-input"
                value={username}
                maxLength={24}
                autoComplete="username"
                spellCheck={false}
                placeholder="ansh"
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>

            {mode === 'signup' ? (
              <Field
                label="Display name"
                htmlFor="account-display"
                hint="How you appear to friends. You can change it later on the server."
              >
                <input
                  id="account-display"
                  className="md-input"
                  value={displayName}
                  maxLength={32}
                  placeholder="Ansh"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
            ) : null}

            <Field
              label="Password"
              htmlFor="account-password"
              hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
            >
              <input
                id="account-password"
                className="md-input"
                type="password"
                value={password}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                placeholder="••••••••"
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                }}
              />
            </Field>

            {formError ? <p className="md-note md-note--error">{formError}</p> : null}

            <div className="md-account__actions">
              <Button
                variant="primary"
                disabled={busy || !username.trim() || !password}
                onClick={() => void submit()}
              >
                {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
              </Button>
            </div>
          </Group>
        </>
      ) : null}

      <Group title="How this works">
        <p className="md-about__text">
          Signed out, Meldrift stays local: rooms, messages and friends live in the
          database on this PC. Signing in switches rooms, chat and presence to your
          server, so friends on other PCs see the same room. Local data is kept and
          returns when you sign out.
        </p>
        <p className="md-about__text">
          Only friends and people in the same room can see your presence. Use an{' '}
          <strong>https://</strong> address if the server is reachable from the internet;
          session tokens are bearer credentials and travel over that connection.
        </p>
      </Group>
    </>
  );
}

/* ---- Profile ----------------------------------------------------------- */

function ProfileSection() {
  const profile = useWorkspace((state) => state.profile);
  const saveProfile = useWorkspace((state) => state.saveProfile);
  const remoteUserId = useNetwork((state) => (state.status === 'signed-out' ? null : state.user?.id));
  const [name, setName] = useState(profile?.displayName ?? '');
  const [handle, setHandle] = useState(profile?.handle ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');

  useEffect(() => {
    setName(profile?.displayName ?? '');
    setHandle(profile?.handle ?? '');
    setBio(profile?.bio ?? '');
  }, [profile?.id]);

  return (
    <>
      <Group title="Identity">
        {remoteUserId ? (
          <p className="md-note">
            Your name, handle and avatar come from your account while you are signed in.
            Sign out from Account settings to edit the local profile.
          </p>
        ) : null}
        <div className="md-profile">
          <Avatar
            name={name || 'Player'}
            color={profile?.avatarColor}
            size={64}
          />
          <div className="md-profile__fields">
            <Field label="Display name" htmlFor="set-name">
              <input
                id="set-name"
                className="md-input"
                value={name}
                maxLength={32}
                disabled={Boolean(remoteUserId)}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => saveProfile({ displayName: name })}
              />
            </Field>
            <Field label="Handle" htmlFor="set-handle" hint="Letters and numbers only.">
              <input
                id="set-handle"
                className="md-input"
                value={handle}
                maxLength={32}
                disabled={Boolean(remoteUserId)}
                onChange={(event) => setHandle(event.target.value)}
                onBlur={() => saveProfile({ handle })}
              />
            </Field>
          </div>
        </div>

        <Field label="About" htmlFor="set-bio" hint="Up to 160 characters. Stored on this PC.">
          <textarea
            id="set-bio"
            className="md-textarea"
            rows={3}
            maxLength={160}
            value={bio}
            disabled={Boolean(remoteUserId)}
            onChange={(event) => setBio(event.target.value)}
            onBlur={() => saveProfile({ bio })}
            placeholder="Tell friends what you play."
          />
        </Field>

        <Field label="Avatar colour">
          <div className="md-swatches">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className="md-swatch"
                style={vars({ '--swatch': color })}
                data-active={profile?.avatarColor === color}
                aria-label={`Use ${color}`}
                disabled={Boolean(remoteUserId)}
                onClick={() => saveProfile({ avatarColor: color })}
              />
            ))}
          </div>
        </Field>
      </Group>
    </>
  );
}

/* ---- Audio ------------------------------------------------------------- */

function AudioSection() {
  const settings = useWorkspace((state) => state.settings);
  const updateSettings = useWorkspace((state) => state.updateSettings);
  const inputs = useVoice((state) => state.inputs);
  const capturing = useVoice((state) => state.capturing);
  const refreshInputs = useVoice((state) => state.refreshInputs);
  const start = useVoice((state) => state.start);
  const stop = useVoice((state) => state.stop);
  const pushToast = useUi((state) => state.pushToast);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [capturingKey, setCapturingKey] = useState(false);

  useEffect(() => {
    void refreshInputs();
    void listAudioOutputs().then(setOutputs).catch(() => setOutputs([]));
  }, [refreshInputs]);

  useEffect(() => {
    if (!capturingKey) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturingKey(false);
        return;
      }
      if (event.key.length !== 1) return;
      void updateSettings({ pushToTalkKey: event.key.toUpperCase() });
      setCapturingKey(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturingKey, updateSettings]);

  const beginMicCheck = async () => {
    const ok = await start({
      deviceId: settings.micDeviceId,
      noiseSuppression: settings.noiseSuppression,
      echoCancellation: settings.echoCancellation,
      autoGainControl: settings.autoGainControl,
      inputVolume: settings.inputVolume,
    });
    if (!ok) pushToast(useVoice.getState().error ?? 'Microphone could not start', 'error');
  };

  return (
    <>
      <Group title="Microphone">
        <Row
          title="Input device"
          hint={inputs.length === 0 ? 'No microphone detected yet — allow access and refresh.' : undefined}
        >
          <div className="md-inline">
            <select
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
            <button
              type="button"
              className="md-icon-btn md-icon-btn--round"
              aria-label="Refresh devices"
              onClick={() => {
                void refreshInputs();
                void listAudioOutputs().then(setOutputs).catch(() => setOutputs([]));
              }}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </Row>

        <Row title="Input level" hint="Applied to the audio other players hear, not just your meter.">
          <div className="md-inline md-inline--grow">
            <Slider
              min={0}
              max={200}
              value={settings.inputVolume}
              aria-label="Microphone input level"
              onValueChange={(value) => {
                voiceEngine.setGain(value);
                void updateSettings({ inputVolume: value });
              }}
            />
            <span className="md-value">{settings.inputVolume}%</span>
          </div>
        </Row>

        <div className="md-miccheck">
          <div className="md-miccheck__head">
            <span className="md-miccheck__label">
              {capturing ? 'Listening' : 'Mic check is off'}
            </span>
            <Button
              size="sm"
              variant={capturing ? 'default' : 'primary'}
              onClick={() => (capturing ? void stop() : void beginMicCheck())}
            >
              {capturing ? 'Stop check' : 'Start check'}
            </Button>
          </div>
          <MicLevel passive={!capturing} />
          <p className="md-hint">
            This check is local. While you are in a room's voice channel, unmuted audio
            is sent to the other members over WebRTC; this check does not transmit.
          </p>
        </div>

        <Row title="Noise suppression">
          <Switch
            label="Noise suppression"
            checked={settings.noiseSuppression}
            onChange={(next) => void updateSettings({ noiseSuppression: next })}
          />
        </Row>
        <Row title="Echo cancellation">
          <Switch
            label="Echo cancellation"
            checked={settings.echoCancellation}
            onChange={(next) => void updateSettings({ echoCancellation: next })}
          />
        </Row>
        <Row title="Automatic gain control">
          <Switch
            label="Automatic gain control"
            checked={settings.autoGainControl}
            onChange={(next) => void updateSettings({ autoGainControl: next })}
          />
        </Row>
        <Row title="Push to talk" hint="The microphone is only live while the key is held.">
          <Switch
            label="Push to talk"
            checked={settings.pushToTalk}
            onChange={(next) => void updateSettings({ pushToTalk: next })}
          />
        </Row>
        <Row title="Push-to-talk key">
          <button
            type="button"
            className="md-keybind"
            data-armed={capturingKey}
            onClick={() => setCapturingKey(true)}
          >
            <Keyboard size={14} />
            {capturingKey ? 'Press a key…' : settings.pushToTalkKey}
          </button>
        </Row>
      </Group>

      <Group title="Speaker">
        <Row title="Output device" hint="Incoming voice plays through this speaker when supported.">
          <select
            className="md-select"
            value={settings.speakerDeviceId}
            onChange={(event) => void updateSettings({ speakerDeviceId: event.target.value })}
          >
            <option value="default">System default</option>
            {outputs.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `Output ${index + 1}`}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Output volume">
          <div className="md-inline md-inline--grow">
            <Slider
              min={0}
              max={200}
              value={settings.outputVolume}
              aria-label="Output volume"
              onValueChange={(value) => void updateSettings({ outputVolume: value })}
            />
            <span className="md-value">{settings.outputVolume}%</span>
          </div>
        </Row>
      </Group>

      <Group title="Voice network">
        <p className="md-note">
          Voice is peer-to-peer. STUN discovers addresses; a TURN server relays audio
          when both peers are behind restrictive NATs. Empty fields use the
          configuration your signaling server advertises. A relay carries roughly
          40 kbps per listener each way, so hosting has a real bandwidth cost — see{' '}
          <strong>docs/VOICE.md</strong>.
        </p>

        <Field
          label="STUN servers"
          htmlFor="voice-stun"
          hint="Comma-separated stun: URLs. Leave empty to use the server default."
        >
          <input
            id="voice-stun"
            className="md-input"
            value={settings.voiceStunUrl}
            placeholder="stun:stun.l.google.com:19302"
            spellCheck={false}
            onChange={(event) => void updateSettings({ voiceStunUrl: event.target.value })}
          />
        </Field>

        <Field
          label="TURN server"
          htmlFor="voice-turn"
          hint="Comma-separated turn: URLs. Required for peers that cannot connect directly."
        >
          <input
            id="voice-turn"
            className="md-input"
            value={settings.voiceTurnUrl}
            placeholder="turn:turn.example.com:3478?transport=udp"
            spellCheck={false}
            onChange={(event) => void updateSettings({ voiceTurnUrl: event.target.value })}
          />
        </Field>

        <Field label="TURN username" htmlFor="voice-turn-user">
          <input
            id="voice-turn-user"
            className="md-input"
            value={settings.voiceTurnUsername}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => void updateSettings({ voiceTurnUsername: event.target.value })}
          />
        </Field>

        <Field
          label="TURN credential"
          htmlFor="voice-turn-credential"
          hint="Stored in this PC's local database, like your session token. Never logged."
        >
          <input
            id="voice-turn-credential"
            className="md-input"
            type="password"
            value={settings.voiceTurnCredential}
            autoComplete="off"
            onChange={(event) => void updateSettings({ voiceTurnCredential: event.target.value })}
          />
        </Field>
      </Group>
    </>
  );
}

/* ---- Streaming --------------------------------------------------------- */

function StreamingSection() {
  const settings = useWorkspace((state) => state.settings);
  const updateSettings = useWorkspace((state) => state.updateSettings);

  return (
    <>
      <div className="md-note">
        <strong>Screen capture runs in WebView2.</strong> The host picks a window or
        display from Windows' own picker, and Meldrift negotiates a direct WebRTC
        video connection to each viewer. Audio stays on its own connection, so
        streaming never interrupts voice.
      </div>

      <Group title="Streaming defaults">
        <Row title="Quality preset" hint="Auto adapts bitrate and resolution to the network.">
          <select
            className="md-select"
            value={settings.streamPreset}
            onChange={(event) =>
              void updateSettings({
                streamPreset: event.target.value as typeof settings.streamPreset,
              })
            }
          >
            {STREAM_PRESET_ORDER.map((preset) => (
              <option key={preset} value={preset}>
                {STREAM_PRESET_SPECS[preset].label}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Maximum resolution" hint="Presets cap resolution; this is the ceiling.">
          <select
            className="md-select"
            value={settings.streamHeight}
            onChange={(event) => void updateSettings({ streamHeight: Number(event.target.value) })}
          >
            {[720, 1080].map((height) => (
              <option key={height} value={height}>
                {resolutionLabel(height)}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Maximum frame rate">
          <select
            className="md-select"
            value={settings.streamFps}
            onChange={(event) => void updateSettings({ streamFps: Number(event.target.value) })}
          >
            {[30, 60].map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
          </select>
        </Row>
      </Group>

      <Group title="Control mode">
        <div className="md-modes">
          <ControlModeCard
            active
            title="Single player"
            text="One remote player controls the game at a time, with a queue for everyone else. The host approves each turn and can revoke instantly."
            onSelect={() => undefined}
          />
        </div>
        <p className="md-hint">
          Simultaneous controllers are a future milestone; this build deliberately accepts
          input from one player only.
        </p>
      </Group>
    </>
  );
}

function ControlModeCard({
  active,
  title,
  text,
  onSelect,
}: {
  active: boolean;
  title: string;
  text: string;
  onSelect: () => void;
}) {
  return (
    <button type="button" className="md-mode" data-active={active} onClick={onSelect}>
      <Gamepad2 size={16} />
      <span className="md-mode__title">{title}</span>
      <span className="md-mode__text">{text}</span>
    </button>
  );
}

/* ---- Appearance -------------------------------------------------------- */

function AppearanceSection() {
  const settings = useWorkspace((state) => state.settings);
  const updateSettings = useWorkspace((state) => state.updateSettings);
  const reduceMotion = useWorkspace((state) => state.settings.reduceMotion);

  return (
    <>
      <Group title="Motion">
        <Row
          title="Reduce motion"
          hint="Windows reduced-motion setting is always respected. This adds an override."
        >
          <Switch
            label="Reduce motion"
            checked={reduceMotion}
            onChange={(next) => void updateSettings({ reduceMotion: next })}
          />
        </Row>
        <Row title="Compact density" hint="Tighter spacing for smaller windows.">
          <Switch
            label="Compact density"
            checked={settings.compactDensity}
            onChange={(next) => void updateSettings({ compactDensity: next })}
          />
        </Row>
      </Group>

      <Group title="Notifications">
        <Row title="Desktop notifications" hint="Used for mentions and invites once messaging syncs.">
          <Switch
            label="Desktop notifications"
            checked={settings.desktopNotifications}
            onChange={(next) => void updateSettings({ desktopNotifications: next })}
          />
        </Row>
      </Group>
    </>
  );
}

/* ---- Data -------------------------------------------------------------- */

function DataSection() {
  const info = useWorkspace((state) => state.info);
  const rooms = useWorkspace((state) => state.rooms);
  const friends = useWorkspace((state) => state.friends);
  const games = useWorkspace((state) => state.games);
  const openModal = useUi((state) => state.openModal);

  return (
    <>
      <Group title="Where your data lives">
        <Row title="Runtime" hint={info?.runtime === 'desktop' ? 'Tauri desktop shell' : 'Browser preview'}>
          <span className="md-value">{info?.runtime === 'desktop' ? 'Desktop' : 'Preview'}</span>
        </Row>
        <Row title="Storage location">
          <span className="md-path" title={info?.dataDir}>
            {info?.dataDir ?? 'Unknown'}
          </span>
        </Row>
      </Group>

      <Group title="Stored on this PC">
        <div className="md-counts">
          <div className="md-count">
            <span className="md-count__value">{rooms.length}</span>
            <span className="md-count__label">Rooms</span>
          </div>
          <div className="md-count">
            <span className="md-count__value">{friends.length}</span>
            <span className="md-count__label">Friends</span>
          </div>
          <div className="md-count">
            <span className="md-count__value">{games.length}</span>
            <span className="md-count__label">Games</span>
          </div>
        </div>
      </Group>

      <Group title="Danger zone">
        <Row
          title="Clear local data"
          hint="Removes your profile, rooms, messages, friends and games from this PC."
        >
          <Button variant="danger" onClick={() => openModal('clear-data')}>
            Clear data
          </Button>
        </Row>
      </Group>
    </>
  );
}

/* ---- About ------------------------------------------------------------- */

function AboutSection() {
  const info = useWorkspace((state) => state.info);
  return (
    <>
      <div className="md-about">
        <h2 className="md-about__name">Meldrift</h2>
        <p className="md-about__tag">Your game. Everyone's turn.</p>
        <p className="md-about__version">
          Version {info?.version ?? APP_VERSION} · alpha
        </p>
      </div>
      <Group title="This build">
        <p className="md-about__text">
          Windows desktop shell with the permanent interface, local rooms, chat and
          friends, plus a self-hostable server for accounts, rooms, messaging and
          presence. Microphone capture is real but local; voice transmission, game
          streaming and remote control are the next milestones and are not simulated
          here.
        </p>
      </Group>
      <Group title="Pricing">
        <p className="md-about__text">
          Free forever. No subscriptions, no ads, no premium tier. Hosting a room for
          friends may need a relay server you run yourself.
        </p>
      </Group>
    </>
  );
}
