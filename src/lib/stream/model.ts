import type { StreamMode, StreamPreset } from '@shared/protocol';

/* --------------------------------------------------------------------------
   Game streaming model.

   Capture happens in WebView2 through getDisplayMedia (Chromium's Windows
   Graphics Capture backend), so frames never cross the Rust/JS boundary. This
   module is pure: presets, capture constraints, the adaptive encoder controller
   and stats parsing, all unit-testable without a browser.
   -------------------------------------------------------------------------- */

export interface StreamPresetSpec {
  label: string;
  summary: string;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  maxBitrateKbps: number;
  minBitrateKbps: number;
  /** What to sacrifice first when the network tightens. */
  priority: 'framerate' | 'resolution' | 'balanced';
}

export const STREAM_PRESET_SPECS: Record<StreamPreset, StreamPresetSpec> = {
  auto: {
    label: 'Auto',
    summary: '720p30, adapts bitrate and scale to the network. Recommended.',
    maxWidth: 1280,
    maxHeight: 720,
    maxFps: 30,
    maxBitrateKbps: 3000,
    minBitrateKbps: 500,
    priority: 'balanced',
  },
  smooth: {
    label: 'Smooth',
    summary: 'Keeps motion fluid; drops resolution before frame rate.',
    maxWidth: 1280,
    maxHeight: 720,
    maxFps: 30,
    maxBitrateKbps: 1800,
    minBitrateKbps: 400,
    priority: 'framerate',
  },
  balanced: {
    label: 'Balanced',
    summary: '1080p30 with room to recover from short network dips.',
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 30,
    maxBitrateKbps: 4000,
    minBitrateKbps: 700,
    priority: 'balanced',
  },
  quality: {
    label: 'Quality',
    summary: '1080p60 where the encoder and upload can sustain it.',
    maxWidth: 1920,
    maxHeight: 1080,
    maxFps: 60,
    maxBitrateKbps: 8000,
    minBitrateKbps: 1200,
    priority: 'resolution',
  },
};

export const STREAM_PRESET_ORDER: StreamPreset[] = ['auto', 'smooth', 'balanced', 'quality'];

export const STREAM_MODE_LABELS: Record<StreamMode, string> = {
  window: 'Game window',
  desktop: 'Entire display',
};

export interface CaptureCeiling {
  /** The host's maximum capture height from Settings. */
  maxHeight: number;
  /** The host's maximum capture frame rate from Settings. */
  maxFps: number;
}

export function captureBounds(
  preset: StreamPreset,
  ceiling: CaptureCeiling,
): { width: number; height: number; fps: number } {
  const spec = STREAM_PRESET_SPECS[preset];
  const height = Math.max(360, Math.min(spec.maxHeight, ceiling.maxHeight));
  const width = Math.min(spec.maxWidth, Math.round((height * 16) / 9));
  const fps = Math.max(15, Math.min(spec.maxFps, ceiling.maxFps));
  return { width, height, fps };
}

/**
 * Chromium-only picker hints are used deliberately:
 *   - window mode excludes monitor surfaces, so a game window is captured and
 *     the desktop is never silently offered instead;
 *   - desktop mode preselects a monitor and disables in-picker source switching.
 * The constraints are advisory to the picker, which still lists real window
 * titles and thumbnails and remains the user's explicit choice.
 */
export function displayCaptureConstraints(
  mode: StreamMode,
  preset: StreamPreset,
  ceiling: CaptureCeiling,
): DisplayMediaStreamOptions {
  const bounds = captureBounds(preset, ceiling);
  const video: MediaTrackConstraints & {
    displaySurface?: 'window' | 'monitor';
  } = {
    width: { ideal: bounds.width, max: Math.min(1920, bounds.width * 2) },
    height: { ideal: bounds.height, max: Math.min(1080, bounds.height * 2) },
    frameRate: { ideal: bounds.fps, max: bounds.fps },
    displaySurface: mode === 'desktop' ? 'monitor' : 'window',
  };
  return {
    video,
    audio: false,
    monitorTypeSurfaces: mode === 'desktop' ? 'include' : 'exclude',
    surfaceSwitching: 'exclude',
    selfBrowserSurface: 'exclude',
    systemAudio: 'exclude',
  } as DisplayMediaStreamOptions;
}

export type StreamQualityReason =
  | 'healthy'
  | 'bandwidth'
  | 'cpu'
  | 'other'
  | 'unknown';

export interface EncodeState {
  bitrateKbps: number;
  /** Encoder downscale factor: 1 = full capture size, 2 = half each axis. */
  scale: number;
  maxFps: number;
}

export interface StreamSample {
  packetsSentDelta: number;
  packetsLostDelta: number;
  /** kbps reported by the selected candidate pair, when available. */
  availableOutgoingKbps?: number;
  rttMs?: number;
  qualityLimitationReason?: string;
  framesPerSecond?: number;
}

export interface EncodingAnalysis {
  state: EncodeState;
  lossRatio: number;
  pressure: boolean;
  availableKbps: number | null;
  reason: StreamQualityReason;
}

export function initialEncodeState(
  preset: StreamPreset,
  ceiling: CaptureCeiling,
): EncodeState {
  const spec = STREAM_PRESET_SPECS[preset];
  const bounds = captureBounds(preset, ceiling);
  return {
    bitrateKbps: Math.min(spec.maxBitrateKbps, Math.max(spec.minBitrateKbps, 1800)),
    scale: 1,
    maxFps: bounds.fps,
  };
}

/** Classify why the encoder is not keeping up, for the UI's honest status. */
export function qualityReason(reason: string | undefined): StreamQualityReason {
  switch (reason) {
    case 'bandwidth':
      return 'bandwidth';
    case 'cpu':
      return 'cpu';
    case 'none':
      return 'healthy';
    case undefined:
      return 'unknown';
    default:
      return 'other';
  }
}

/**
 * One adaptation step. Loss above 3%, a bandwidth limitation, a shrinking
 * available bitrate or a high RTT tightens the stream (up to 15% bitrate at a
 * time). Sustained health walks it back toward the preset ceiling. Framerate-
 * first presets trade resolution; quality presets trade frame rate.
 */
export function adaptEncoding(
  previous: EncodeState,
  sample: StreamSample,
  preset: StreamPreset,
  ceiling: CaptureCeiling,
): EncodingAnalysis {
  const spec = STREAM_PRESET_SPECS[preset];
  const bounds = captureBounds(preset, ceiling);
  const sent = Math.max(0, sample.packetsSentDelta);
  const lost = Math.max(0, sample.packetsLostDelta);
  const lossRatio = sent + lost > 0 ? lost / (sent + lost) : 0;
  const availableKbps =
    sample.availableOutgoingKbps !== undefined && sample.availableOutgoingKbps > 0
      ? sample.availableOutgoingKbps
      : null;

  const pressure =
    lossRatio > 0.03 ||
    qualityReason(sample.qualityLimitationReason) === 'bandwidth' ||
    (availableKbps !== null && availableKbps < previous.bitrateKbps * 1.15) ||
    (sample.rttMs !== undefined && sample.rttMs > 250);
  const healthy =
    lossRatio < 0.01 &&
    qualityReason(sample.qualityLimitationReason) !== 'bandwidth' &&
    (availableKbps === null || availableKbps > previous.bitrateKbps * 1.4) &&
    (sample.rttMs === undefined || sample.rttMs < 180);

  const next: EncodeState = { ...previous };
  if (pressure) {
    next.bitrateKbps = Math.max(spec.minBitrateKbps, Math.round(previous.bitrateKbps * 0.85));
    if (spec.priority === 'resolution') {
      if (previous.maxFps > 24) next.maxFps = Math.max(24, previous.maxFps - 5);
      else next.scale = Math.min(2, previous.scale * 1.08);
    } else {
      next.scale = Math.min(2, previous.scale * 1.08);
      if (previous.scale >= 1.98) {
        next.maxFps = Math.max(spec.priority === 'framerate' ? 24 : 20, previous.maxFps - 4);
      }
    }
  } else if (healthy) {
    next.bitrateKbps = Math.min(spec.maxBitrateKbps, Math.round(previous.bitrateKbps * 1.06));
    if (previous.scale > 1) next.scale = Math.max(1, previous.scale * 0.93);
    if (previous.maxFps < bounds.fps) next.maxFps = Math.min(bounds.fps, previous.maxFps + 2);
  }

  next.bitrateKbps = Math.max(spec.minBitrateKbps, Math.min(spec.maxBitrateKbps, next.bitrateKbps));
  next.scale = Math.max(1, Math.min(2, Number(next.scale.toFixed(3))));
  next.maxFps = Math.max(15, Math.min(bounds.fps, Math.round(next.maxFps)));

  return {
    state: next,
    lossRatio,
    pressure,
    availableKbps,
    reason: pressure
      ? qualityReason(sample.qualityLimitationReason) === 'bandwidth' || lossRatio > 0.03
        ? 'bandwidth'
        : qualityReason(sample.qualityLimitationReason)
      : healthy
        ? 'healthy'
        : qualityReason(sample.qualityLimitationReason),
  };
}

export interface SenderStatsSummary {
  sample: StreamSample;
  bytesSent: number;
  framesEncoded: number;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  encoder: string | null;
  codec: string | null;
  qualityLimitationReason: string | null;
}

interface StatsLike {
  type: string;
  kind?: string;
  [key: string]: unknown;
}

/**
 * Reads the browser's RTCStatsReport. Deltas are computed by the caller from
 * cumulative counters; this parses one report for a sender.
 */
export function readSenderReport(
  report: Iterable<StatsLike>,
  codecLookup: (id: string) => string | null = () => null,
): SenderStatsSummary {
  let packetsSent = 0;
  let packetsLost = 0;
  let bytesSent = 0;
  let framesEncoded = 0;
  let frameWidth: number | null = null;
  let frameHeight: number | null = null;
  let framesPerSecond: number | null = null;
  let encoder: string | null = null;
  let qualityLimitationReason: string | null = null;
  let availableOutgoingKbps: number | undefined;
  let rttMs: number | undefined;
  let codecId: string | null = null;

  for (const entry of report as Iterable<unknown>) {
    // Chromium iterates RTCStatsReport as [id, stat] pairs; test doubles and
    // some runtimes hand back the stat objects directly. Accept both.
    const stat = (Array.isArray(entry) ? entry[1] : entry) as StatsLike | null;
    if (!stat || typeof stat.type !== 'string') continue;
    if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
      packetsSent += Number(stat.packetsSent ?? 0);
      bytesSent += Number(stat.bytesSent ?? 0);
      framesEncoded += Number(stat.framesEncoded ?? 0);
      frameWidth = typeof stat.frameWidth === 'number' ? stat.frameWidth : frameWidth;
      frameHeight = typeof stat.frameHeight === 'number' ? stat.frameHeight : frameHeight;
      framesPerSecond =
        typeof stat.framesPerSecond === 'number' ? stat.framesPerSecond : framesPerSecond;
      encoder = typeof stat.encoderImplementation === 'string' ? stat.encoderImplementation : encoder;
      qualityLimitationReason =
        typeof stat.qualityLimitationReason === 'string'
          ? stat.qualityLimitationReason
          : qualityLimitationReason;
      codecId = typeof stat.codecId === 'string' ? stat.codecId : codecId;
    }
    if (stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
      packetsLost += Number(stat.packetsLost ?? 0);
      if (typeof stat.roundTripTime === 'number') {
        rttMs = Math.max(rttMs ?? 0, stat.roundTripTime * 1000);
      }
    }
    if (stat.type === 'candidate-pair' && (stat.state === 'succeeded' || stat.nominated === true)) {
      if (typeof stat.availableOutgoingBitrate === 'number' && stat.availableOutgoingBitrate > 0) {
        availableOutgoingKbps = stat.availableOutgoingBitrate / 1000;
      }
    }
  }

  return {
    sample: {
      packetsSentDelta: packetsSent,
      packetsLostDelta: packetsLost,
      availableOutgoingKbps: availableOutgoingKbps,
      rttMs,
      qualityLimitationReason: qualityLimitationReason ?? undefined,
      framesPerSecond: framesPerSecond ?? undefined,
    },
    bytesSent,
    framesEncoded,
    frameWidth,
    frameHeight,
    framesPerSecond,
    encoder,
    codec: codecId ? codecLookup(codecId) : null,
    qualityLimitationReason,
  };
}

export interface ReceiverStatsSummary {
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  jitterMs: number;
  framesDecoded: number;
  framesDropped: number;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  codec: string | null;
  decoder: string | null;
}

export function readReceiverReport(
  report: Iterable<StatsLike>,
  codecLookup: (id: string) => string | null = () => null,
): ReceiverStatsSummary {
  let summary: ReceiverStatsSummary = {
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
    jitterMs: 0,
    framesDecoded: 0,
    framesDropped: 0,
    frameWidth: null,
    frameHeight: null,
    framesPerSecond: null,
    codec: null,
    decoder: null,
  };
  for (const entry of report as Iterable<unknown>) {
    const stat = (Array.isArray(entry) ? entry[1] : entry) as StatsLike | null;
    if (!stat || typeof stat.type !== 'string') continue;
    if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
      summary = {
        ...summary,
        bytesReceived: summary.bytesReceived + Number(stat.bytesReceived ?? 0),
        packetsReceived: summary.packetsReceived + Number(stat.packetsReceived ?? 0),
        packetsLost: summary.packetsLost + Number(stat.packetsLost ?? 0),
        jitterMs: Math.max(summary.jitterMs, Number(stat.jitter ?? 0) * 1000),
        framesDecoded: summary.framesDecoded + Number(stat.framesDecoded ?? 0),
        framesDropped: summary.framesDropped + Number(stat.framesDropped ?? 0),
        frameWidth: typeof stat.frameWidth === 'number' ? stat.frameWidth : summary.frameWidth,
        frameHeight: typeof stat.frameHeight === 'number' ? stat.frameHeight : summary.frameHeight,
        framesPerSecond:
          typeof stat.framesPerSecond === 'number' ? stat.framesPerSecond : summary.framesPerSecond,
        decoder:
          typeof stat.decoderImplementation === 'string'
            ? stat.decoderImplementation
            : summary.decoder,
        codec: typeof stat.codecId === 'string' ? codecLookup(stat.codecId) : summary.codec,
      };
    }
  }
  return summary;
}

export function describeCaptureError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  switch (name) {
    case 'NotAllowedError':
      return message.includes('cancelled') || message.includes('canceled')
        ? 'Screen sharing was cancelled.'
        : 'Windows or WebView2 did not allow capture. Check screen-recording permission in Windows Settings.';
    case 'NotFoundError':
      return 'No capturable window or display was selected.';
    case 'NotReadableError':
      return 'Windows could not read that window. Some protected or exclusive-fullscreen games cannot be captured.';
    case 'AbortError':
      return 'Capture stopped before it started.';
    case 'SecurityError':
      return 'Windows blocked capture of that surface (DRM-protected or protected content).';
    case 'InvalidStateError':
      return 'Capture must be started from the Share button in the app.';
    case 'NotSupportedError':
      return 'This WebView2 version does not support screen capture. Update the WebView2 runtime.';
    default:
      return error instanceof Error && error.message
        ? error.message
        : 'Could not start screen capture.';
  }
}

export function formatBitrate(kbps: number | null | undefined): string {
  if (!kbps || kbps <= 0) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`;
}

export function modeLabel(mode: StreamMode): string {
  return STREAM_MODE_LABELS[mode];
}

export function presetLabel(preset: StreamPreset): string {
  return STREAM_PRESET_SPECS[preset].label;
}
