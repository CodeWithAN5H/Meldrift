import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION, versionChannel, versionLabel } from '../src/lib/version';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('release version', () => {
  it('derives the channel from the version instead of a hardcoded label', () => {
    expect(versionChannel('0.7.0-alpha.1')).toBe('Alpha');
    expect(versionChannel('0.7.0-beta.2')).toBe('Beta');
    expect(versionChannel('1.0.0')).toBe('Stable');
    expect(versionLabel('0.7.0-alpha.1')).toBe('0.7.0-alpha.1 · Alpha');
    expect(versionLabel('1.0.0')).toBe('1.0.0 · Stable');
  });

  it('keeps APP_VERSION (what About shows) in step with every build source', () => {
    const pkg = JSON.parse(read('package.json')).version as string;
    const server = JSON.parse(read('server/package.json')).version as string;
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')).version as string;
    const cargo = read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const lock = read('src-tauri/Cargo.lock').match(
      /\[\[package\]\]\s*\nname = "meldrift"\s*\nversion = "([^"]+)"/,
    )?.[1];

    expect(APP_VERSION).toBe(pkg);
    expect(APP_VERSION).toBe(server);
    expect(APP_VERSION).toBe(tauri);
    expect(APP_VERSION).toBe(cargo);
    expect(APP_VERSION).toBe(lock);
    // A future bump must not leave About on an old release.
    expect(versionLabel(APP_VERSION)).toBe(`${pkg} · ${versionChannel(pkg)}`);
  });
});
