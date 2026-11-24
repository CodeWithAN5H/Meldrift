/**
 * Single source of truth for the app version shown in the UI.
 * Kept in sync with package.json / tauri.conf.json / Cargo.toml by
 * scripts/check-version.mjs (run in CI).
 */
export const APP_VERSION = '0.3.0-alpha.1';
