import { describe, expect, it } from 'vitest';
import {
  colorFor,
  defaultSettings,
  initialsOf,
  isValidInviteCode,
  makeInviteCode,
  normalizeInviteCode,
  sanitizeMessageBody,
  sanitizeSettings,
} from '../src/lib/model';

describe('invite codes', () => {
  it('generates seven unambiguous characters', () => {
    for (let index = 0; index < 100; index += 1) {
      const code = makeInviteCode();
      expect(code).toHaveLength(7);
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{7}$/);
      expect(isValidInviteCode(code)).toBe(true);
    }
  });

  it('normalises pasted codes', () => {
    expect(normalizeInviteCode(' k7m2-qx9 ')).toBe('K7M2QX9');
    expect(isValidInviteCode('K7M2QX9')).toBe(true);
    expect(isValidInviteCode('K7M2QX')).toBe(false);
    expect(isValidInviteCode('K7M2QX0')).toBe(false);
  });
});

describe('settings sanitising', () => {
  it('falls back to defaults for empty input', () => {
    expect(sanitizeSettings(null)).toEqual(defaultSettings());
  });

  it('clamps numeric ranges and rejects bad values', () => {
    const settings = sanitizeSettings({
      inputVolume: 900,
      outputVolume: -40,
      streamFps: 500,
      streamHeight: 100,
      controlMode: 'triple' as never,
      pushToTalkKey: 'x'.repeat(40),
    });

    expect(settings.inputVolume).toBe(200);
    expect(settings.outputVolume).toBe(0);
    expect(settings.streamFps).toBe(60);
    expect(settings.streamHeight).toBe(360);
    expect(settings.controlMode).toBe('single');
    expect(settings.pushToTalkKey).toBe(defaultSettings().pushToTalkKey);
  });

  it('keeps booleans that are explicitly set', () => {
    const settings = sanitizeSettings({ reduceMotion: true, noiseSuppression: false });
    expect(settings.reduceMotion).toBe(true);
    expect(settings.noiseSuppression).toBe(false);
  });
});

describe('message sanitising', () => {
  it('trims and normalises newlines', () => {
    expect(sanitizeMessageBody('  hello\r\nworld  ')).toBe('hello\nworld');
  });

  it('caps the length and drops blank messages', () => {
    expect(sanitizeMessageBody('   ')).toBe('');
    expect(sanitizeMessageBody('a'.repeat(3000))).toHaveLength(2000);
  });
});

describe('identity helpers', () => {
  it('derives initials', () => {
    expect(initialsOf('Player One')).toBe('PO');
    expect(initialsOf('player')).toBe('PL');
    expect(initialsOf('   ')).toBe('?');
  });

  it('maps a name to a stable colour', () => {
    expect(colorFor('Player One')).toBe(colorFor('Player One'));
    expect(colorFor('Player One')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
