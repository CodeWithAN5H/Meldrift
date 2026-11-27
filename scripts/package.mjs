#!/usr/bin/env node
/**
 * Turns the NSIS artifact Tauri produces into the exact release asset name
 * (Meldrift-Setup.exe), records its real Authenticode state, and hashes the
 * final file that will be uploaded.
 *
 * Signing must happen BEFORE this script runs. The checksum is computed from
 * the copied installer, so a signature applied afterwards can never produce a
 * checksum that no longer matches the uploaded artifact.
 */
import { execFileSync } from 'node:child_process';
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
const requireSigning = ['1', 'true'].includes(
  String(process.env.MELDRIFT_REQUIRE_SIGNING ?? '').toLowerCase(),
);

// A pwsh-based parent shell (GitHub's Windows runners) leaves PSModulePath
// pointing at PowerShell 7's modules, so Windows PowerShell 5.1 cannot autoload
// its own Microsoft.PowerShell.Security module and Get-AuthenticodeSignature
// fails. Dropping the variable lets the child rebuild its default module path.
const powershellEnv = { ...process.env };
delete powershellEnv.PSModulePath;

function signatureState(file) {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'scripts', 'signature-state.ps1'),
      '-Path',
      file,
    ],
    { encoding: 'utf8', env: powershellEnv },
  ).trim();
  return JSON.parse(output);
}

let source = process.env.MELDRIFT_INSTALLER_SOURCE?.trim();
if (!source) {
  if (!existsSync(bundleDir)) {
    console.error(`Missing NSIS bundle directory: ${bundleDir}`);
    console.error('Run "bun run tauri bundle" first.');
    process.exit(1);
  }
  const candidates = readdirSync(bundleDir)
    .filter((file) => file.toLowerCase().endsWith('.exe'))
    .map((file) => join(bundleDir, file));
  if (candidates.length === 0) {
    console.error('No installer executable found in the NSIS bundle.');
    process.exit(1);
  }
  source = candidates.sort(
    (a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs,
  )[0];
}

if (!existsSync(source)) {
  console.error(`Installer source does not exist: ${source}`);
  process.exit(1);
}

const signature = signatureState(source);
const signed = signature.status === 'Valid';

if (requireSigning && !signed) {
  console.error(
    `Signing is required but ${source} has Authenticode status "${signature.status}".`,
  );
  console.error('Refusing to package a release that would be reported as signed.');
  process.exit(1);
}

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
  signed,
  signatureStatus: signature.status,
  signer: signed ? signature.signer : null,
};

writeFileSync(join(outDir, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`Packaged ${outputName}`);
console.log(`  version:   ${version}`);
console.log(`  size:      ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  sha256:    ${digest}`);
console.log(`  signature: ${signature.status}${signed ? ` (${signature.signer})` : ''}`);
if (!signed) {
  console.log(
    '  note:      unsigned build. Configure SIGN_PFX_BASE64 / SIGN_PFX_PASSWORD to sign — see docs/RELEASING.md.',
  );
}
