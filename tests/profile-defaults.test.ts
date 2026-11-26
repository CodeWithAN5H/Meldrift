import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeProfile } from '@/lib/model';
import { DISPLAY_NAME_PLACEHOLDER, USERNAME_PLACEHOLDER } from '@/lib/profileText';

/* Profile copy and defaults must stay neutral. A maintainer's personal name is
   not a placeholder, an example, or a default anywhere in shipped code. */

const root = process.cwd();
const personalName = /ansh/i;

function sourceFiles(dir: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (['.ts', '.tsx', '.rs', '.html'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

describe('profile defaults', () => {
  it('uses neutral placeholder text', () => {
    expect(DISPLAY_NAME_PLACEHOLDER).toBe('Display name');
    expect(USERNAME_PLACEHOLDER).toBe('username');

    const onboarding = readFileSync(join(root, 'src/features/onboarding/Onboarding.tsx'), 'utf8');
    const settings = readFileSync(join(root, 'src/features/settings/SettingsView.tsx'), 'utf8');
    expect(onboarding).toContain('DISPLAY_NAME_PLACEHOLDER');
    expect(settings).toContain('DISPLAY_NAME_PLACEHOLDER');
    expect(settings).toContain('USERNAME_PLACEHOLDER');
  });

  it('never hardcodes the maintainer name in shipped code or fixtures', () => {
    const files = [
      ...sourceFiles('src'),
      ...sourceFiles('server/src'),
      ...sourceFiles('shared'),
      ...sourceFiles('src-tauri/src'),
      ...sourceFiles('tests'),
      ...sourceFiles('server/test'),
    ].filter((file) => !file.endsWith('profile-defaults.test.ts'));
    const offenders = files.filter((file) => personalName.test(readFileSync(join(root, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('falls back to a generic profile instead of an OS account name', () => {
    const fallback = makeProfile('');
    expect(fallback.displayName).toBe('Player');
    expect(fallback.handle).toBe('player');
    // A user-entered name is preserved exactly (apart from trimming).
    expect(makeProfile('  Player One  ').displayName).toBe('Player One');
  });
});
