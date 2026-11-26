#!/usr/bin/env node
/**
 * Verifies the release assets before anything is uploaded:
 *  - the installer is a real Windows executable of the expected size,
 *  - its PE version resource matches package.json,
 *  - SHA256SUMS.txt matches the exact installer bytes,
 *  - build-report.json matches the file and its real Authenticode status,
 *  - signing is valid whenever MELDRIFT_REQUIRE_SIGNING=1.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, 'artifacts');
const installer = join(artifacts, 'Meldrift-Setup.exe');
const sumsPath = join(artifacts, 'SHA256SUMS.txt');
const reportPath = join(artifacts, 'build-report.json');
const notesPath = join(artifacts, 'RELEASE_NOTES.md');
const requireSigning = ['1', 'true'].includes(
  String(process.env.MELDRIFT_REQUIRE_SIGNING ?? '').toLowerCase(),
);

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

for (const path of [installer, sumsPath, reportPath, notesPath]) {
  check(existsSync(path), `missing artifact: ${path}`);
}
if (failures.length > 0) {
  failures.forEach((message) => console.error(`FAIL ${message}`));
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const sums = readFileSync(sumsPath, 'utf8').trim();
const notes = readFileSync(notesPath, 'utf8');
const bytes = statSync(installer).size;
const digest = createHash('sha256').update(readFileSync(installer)).digest('hex');

const header = Buffer.alloc(2);
const fd = openSync(installer, 'r');
readSync(fd, header, 0, 2, 0);
closeSync(fd);

check(bytes >= 1024 * 1024, `installer is only ${bytes} bytes`);
check(header.toString('latin1') === 'MZ', 'installer is not a PE executable');
check(report.product === 'Meldrift', 'build report product is not Meldrift');
check(report.version === version, `build report version ${report.version} != ${version}`);
check(report.asset === 'Meldrift-Setup.exe', 'build report asset name is wrong');
check(report.bytes === bytes, `build report bytes ${report.bytes} != ${bytes}`);
check(report.sha256 === digest, 'build report sha256 does not match the installer');
check(new RegExp(`^${digest}  Meldrift-Setup\\.exe$`, 'm').test(sums), 'SHA256SUMS.txt does not match the installer');
check(notes.includes(version), 'release notes do not name the release version');
check(notes.includes(digest), 'release notes do not include the installer checksum');

function runPowerShell(script, path) {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'scripts', script),
      '-Path',
      path,
    ],
    { encoding: 'utf8' },
  ).trim();
  return JSON.parse(output);
}

const signature = runPowerShell('signature-state.ps1', installer);
check(
  report.signed === (signature.status === 'Valid'),
  `build report signed=${report.signed} but Authenticode status is ${signature.status}`,
);
check(
  !report.signed || report.signer === signature.signer,
  'build report signer does not match the installer certificate',
);
if (requireSigning) {
  check(signature.status === 'Valid', `signing is required but status is ${signature.status}`);
}

const info = runPowerShell('version-info.ps1', installer);
check(
  info.productVersion === version,
  `installer product version ${info.productVersion} != ${version}`,
);
check(info.productName === 'Meldrift', `installer product name ${info.productName} != Meldrift`);

if (failures.length > 0) {
  failures.forEach((message) => console.error(`FAIL ${message}`));
  process.exit(1);
}

console.log(`Verified ${report.asset}`);
console.log(`  version:   ${version}`);
console.log(`  bytes:     ${bytes}`);
console.log(`  sha256:    ${digest}`);
console.log(`  signature: ${signature.status}${signature.signer ? ` (${signature.signer})` : ''}`);
console.log(`  notes:     ${notesPath}`);
