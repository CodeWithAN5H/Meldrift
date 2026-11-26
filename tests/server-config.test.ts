import { describe, expect, it } from 'vitest';
import {
  assertSecureTransport,
  isLocalOrPrivateHost,
  normalizeServerUrl,
  websocketUrl,
} from '@/lib/net/api';
import { isLoopbackUrl, resolveSessionServer } from '@/lib/signaling';
import { defaultSettings, sanitizeSettings } from '@/lib/model';

describe('server mode settings', () => {
  it('defaults to local mode with no remote address', () => {
    expect(defaultSettings().serverMode).toBe('local');
    expect(defaultSettings().remoteServerUrl).toBe('');
  });

  it('persists remote mode and its address', () => {
    const settings = sanitizeSettings({
      serverMode: 'remote',
      remoteServerUrl: 'https://voice.example.com',
    });
    expect(settings.serverMode).toBe('remote');
    expect(settings.remoteServerUrl).toBe('https://voice.example.com');
  });

  it('rejects unknown modes and caps a stored address', () => {
    const settings = sanitizeSettings({
      serverMode: 'somewhere-else' as never,
      remoteServerUrl: 'x'.repeat(900),
    });
    expect(settings.serverMode).toBe('local');
    expect(settings.remoteServerUrl).toHaveLength(512);
  });
});

describe('server addresses', () => {
  it('normalises host:port and strips paths and trailing slashes', () => {
    expect(normalizeServerUrl('voice.example.com:8787/')).toBe('http://voice.example.com:8787');
    expect(normalizeServerUrl(' https://voice.example.com/api/ ')).toBe(
      'https://voice.example.com/api',
    );
  });

  it('requires https for public internet servers', () => {
    expect(() => assertSecureTransport('https://voice.example.com')).not.toThrow();
    expect(() => assertSecureTransport('http://voice.example.com')).toThrow(/https/i);
    expect(() => assertSecureTransport('http://127.0.0.1:8787')).not.toThrow();
    expect(() => assertSecureTransport('http://192.168.1.20:8787')).not.toThrow();
  });

  it('classifies loopback and private LAN hosts', () => {
    expect(isLocalOrPrivateHost('localhost')).toBe(true);
    expect(isLocalOrPrivateHost('127.0.0.1')).toBe(true);
    expect(isLocalOrPrivateHost('10.1.2.3')).toBe(true);
    expect(isLocalOrPrivateHost('172.20.0.1')).toBe(true);
    expect(isLocalOrPrivateHost('172.40.0.1')).toBe(false);
    expect(isLocalOrPrivateHost('voice.example.com')).toBe(false);
  });

  it('uses wss with https and ws with http', () => {
    expect(websocketUrl('https://voice.example.com', 't')).toMatch(/^wss:\/\/voice\.example\.com\/ws\?token=t$/);
    expect(websocketUrl('http://127.0.0.1:8787', 't')).toMatch(/^ws:\/\/127\.0\.0\.1:8787\/ws\?token=t$/);
  });
});

describe('local session rebinding', () => {
  it('moves an old loopback session to the port the sidecar chose', () => {
    expect(
      resolveSessionServer('http://127.0.0.1:8787', 'local', 'http://127.0.0.1:8791'),
    ).toBe('http://127.0.0.1:8791');
    expect(isLoopbackUrl('http://localhost:8787')).toBe(true);
  });

  it('never rewrites a remote server, even when it is loopback', () => {
    const url = 'http://127.0.0.1:8787';
    expect(resolveSessionServer(url, 'remote', 'http://127.0.0.1:8791')).toBe(url);
  });

  it('does not rewrite a non-loopback session in local mode', () => {
    const url = 'https://voice.example.com';
    expect(resolveSessionServer(url, 'local', 'http://127.0.0.1:8791')).toBe(url);
  });
});
