#!/usr/bin/env node
/**
 * Guards against drift between the four places a version number lives.
 * A pushed tag must match the version, so a release can never be mislabelled.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const pkg = JSON.parse(read('package.json')).version;
const tauri = JSON.parse(read('src-tauri/tauri.conf.json')).version;
const cargo = read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const ts = read('src/lib/version.ts').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];

const seen = { 'package.json': pkg, 'tauri.conf.json': tauri, 'Cargo.toml': cargo, 'version.ts': ts };
const unique = new Set(Object.values(seen));

if (unique.size !== 1) {
  console.error('Version mismatch across sources:');
  for (const [file, value] of Object.entries(seen)) {
    console.error(`  ${file}: ${value ?? 'missing'}`);
  }
  process.exit(1);
}

const tag = process.env.GITHUB_REF_NAME ?? process.env.MELDRIFT_TAG ?? '';
if (tag && tag.replace(/^v/, '') !== pkg) {
  console.error(`Tag ${tag} does not match version ${pkg}.`);
  process.exit(1);
}

console.log(`Version ${pkg} is consistent.`);
