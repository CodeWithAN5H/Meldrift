#!/usr/bin/env node
/**
 * Guards against drift between every place a version number lives, including
 * the server package and the Rust lockfile. A pushed tag must match the
 * version, so a release can never be mislabelled.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

const pkg = JSON.parse(read('package.json')).version;
const server = JSON.parse(read('server/package.json')).version;
const tauri = JSON.parse(read('src-tauri/tauri.conf.json')).version;
const cargo = read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lock = read('src-tauri/Cargo.lock').match(/\[\[package\]\]\s*\nname = "meldrift"\s*\nversion = "([^"]+)"/)?.[1];
const ts = read('src/lib/version.ts').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];

const seen = {
  'package.json': pkg,
  'server/package.json': server,
  'tauri.conf.json': tauri,
  'Cargo.toml': cargo,
  'Cargo.lock': lock,
  'version.ts': ts,
};
const unique = new Set(Object.values(seen));

if (unique.size !== 1) {
  console.error('Version mismatch across sources:');
  for (const [file, value] of Object.entries(seen)) {
    console.error(`  ${file}: ${value ?? 'missing'}`);
  }
  process.exit(1);
}

// GitHub sets GITHUB_REF_NAME to the branch name on branch pushes and to the
// tag name only on tag pushes, so compare against the version only for tags.
const refType = process.env.GITHUB_REF_TYPE;
const ref = process.env.GITHUB_REF ?? '';
const isTagRef = refType === 'tag' || (refType === undefined && ref.startsWith('refs/tags/'));
const tag = isTagRef ? process.env.GITHUB_REF_NAME || ref.replace(/^refs\/tags\//, '') : process.env.MELDRIFT_TAG ?? '';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$/;

if (!VERSION_PATTERN.test(pkg)) {
  console.error(`Version ${pkg} is not a supported release version.`);
  process.exit(1);
}

if (tag) {
  if (!TAG_PATTERN.test(tag)) {
    console.error(`Tag ${tag} is not a supported release tag (expected v<version>).`);
    process.exit(1);
  }
  if (tag.slice(1) !== pkg) {
    console.error(`Tag ${tag} does not match version ${pkg}.`);
    process.exit(1);
  }
}

console.log(`Version ${pkg} is consistent.`);
