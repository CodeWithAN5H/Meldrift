/**
 * Single source of truth for the app version shown in the UI.
 * Kept in sync with package.json / tauri.conf.json / Cargo.toml by
 * scripts/check-version.mjs (run in CI).
 */
export const APP_VERSION = '0.7.0-alpha.1';

export type ReleaseChannel = 'Alpha' | 'Beta' | 'Stable';

/**
 * The channel is part of the version string, never a separate hardcoded label.
 * A beta or stable build therefore cannot keep claiming to be alpha.
 */
export function versionChannel(version: string): ReleaseChannel {
  if (/-alpha(?:[.+-]|$)/i.test(version)) return 'Alpha';
  if (/-beta(?:[.+-]|$)/i.test(version)) return 'Beta';
  return 'Stable';
}

/** The exact wording the About screen shows. */
export function versionLabel(version: string): string {
  return `${version} · ${versionChannel(version)}`;
}
