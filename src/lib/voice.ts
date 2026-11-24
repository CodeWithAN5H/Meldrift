/* --------------------------------------------------------------------------
   Voice engine

   Real microphone capture and analysis. This is the foundation the WebRTC
   session in M3 plugs into: capture, gain, mute and level metering already
   work, so the audio graph and device handling are validated early.

   No transmission happens here. Nothing in the UI claims a peer connection
   exists until the signaling service lands.
   -------------------------------------------------------------------------- */

export interface CaptureOptions {
  deviceId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  gain: number;
}

type LevelListener = (level: number) => void;

export class VoiceEngine {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private frame = 0;
  private smoothed = 0;
  private listeners = new Set<LevelListener>();
  private muted = false;

  get active(): boolean {
    return this.stream !== null;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  get trackLabel(): string | null {
    return this.stream?.getAudioTracks()[0]?.label ?? null;
  }

  async start(options: CaptureOptions): Promise<void> {
    await this.stop();
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: options.deviceId === 'default' ? undefined : { exact: options.deviceId },
        noiseSuppression: options.noiseSuppression,
        echoCancellation: options.echoCancellation,
        autoGainControl: options.autoGainControl,
        channelCount: 1,
      },
      video: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;

    const AudioCtor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioCtor({ latencyHint: 'interactive' });
    this.context = context;
    if (context.state === 'suspended') await context.resume();

    const source = context.createMediaStreamSource(stream);
    this.source = source;

    const gainNode = context.createGain();
    gainNode.gain.value = Math.max(0, Math.min(2, options.gain / 100));
    this.gainNode = gainNode;

    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    this.analyser = analyser;

    source.connect(gainNode);
    gainNode.connect(analyser);

    for (const track of stream.getAudioTracks()) {
      track.enabled = !this.muted;
      track.addEventListener('ended', () => this.stop(), { once: true });
    }

    this.tick();
  }

  async stop(): Promise<void> {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.source?.disconnect();
    this.gainNode?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    const context = this.context;
    this.stream = null;
    this.source = null;
    this.gainNode = null;
    this.analyser = null;
    this.context = null;
    this.smoothed = 0;
    this.emit(0);
    if (context && context.state !== 'closed') {
      await context.close().catch(() => undefined);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setGain(value: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(2, value / 100));
    }
  }

  subscribe(listener: LevelListener): () => void {
    this.listeners.add(listener);
    listener(this.smoothed);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(level: number): void {
    for (const listener of this.listeners) listener(level);
  }

  /** Analyser polling only runs while someone is watching the meter. */
  private tick = (): void => {
    const analyser = this.analyser;
    if (!analyser) return;
    const buffer = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const value = (buffer[i] - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / buffer.length);
    const scaled = Math.min(1, rms * 3.2);
    // Fast attack, slow release reads like a real meter.
    this.smoothed =
      scaled > this.smoothed
        ? scaled
        : this.smoothed * 0.86 + scaled * 0.14;
    this.emit(this.smoothed);
    this.frame = requestAnimationFrame(this.tick);
  };
}

export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput');
}

export async function listAudioOutputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audiooutput');
}

export function describeMediaError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
      return 'Microphone access was denied. Allow it in Windows settings.';
    case 'NotFoundError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
      return 'The microphone is busy in another application.';
    case 'OverconstrainedError':
      return 'That microphone is no longer available. Pick another device.';
    default:
      return error instanceof Error ? error.message : 'Microphone could not be started.';
  }
}

export const voiceEngine = new VoiceEngine();
