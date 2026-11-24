#!/usr/bin/env node
/**
 * Turns the NSIS artifact Tauri produces into the exact release asset name
 * (Meldrift-Setup.exe) and validates it before anything is published.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const outDir = join(root, 'artifacts');
const outputName = 'Meldrift-Setup.exe';

if (!existsSync(bundleDir)) {
  console.error(`Missing NSIS bundle directory: ${bundleDir}`);
  console.error('Run "bun run tauri build" first.');
  process.exit(1);
}

const candidates = readdirSync(bundleDir)
  .filter((file) => file.toLowerCase().endsWith('.exe'))
  .map((file) => join(bundleDir, file));

if (candidates.length === 0) {
  console.error('No installer executable found in the NSIS bundle.');
  process.exit(1);
}

const source = candidates.sort(
  (a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs,
)[0];

const size = statSync(source).size;
// A Tauri NSIS build is a small self-extracting exe (the WebView2 runtime is
// bootstrapped, not embedded), so guard against truncation with the PE header
// plus a conservative floor rather than an arbitrary large size.
const minimumBytes = 1 * 1024 * 1024;
const header = Buffer.alloc(2);
const fileHandle = openSync(source, 'r');
readSync(fileHandle, header, 0, 2, 0);
closeSync(fileHandle);
if (size < minimumBytes || header.toString('latin1') !== 'MZ') {
  console.error(`Installer is not a valid Windows executable (${size} bytes). Refusing to package.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const target = join(outDir, outputName);
copyFileSync(source, target);

const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(join(outDir, 'SHA256SUMS.txt'), `${digest}  ${outputName}\n`, 'utf8');

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const report = {
  product: 'Meldrift',
  version,
  asset: outputName,
  bytes: size,
  sha256: digest,
  signed: false,
};

writeFileSync(join(outDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`Packaged ${outputName}`);
console.log(`  version: ${version}`);
console.log(`  size:    ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  sha256:  ${digest}`);
console.log('  signed:  no (configure a certificate to sign — see docs/RELEASING.md)');
