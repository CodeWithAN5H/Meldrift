#!/usr/bin/env node
/**
 * Writes artifacts/RELEASE_NOTES.md from the verified build report and the
 * version-specific highlights in docs/releases/<version>.md.
 *
 * The signing paragraph is generated from the real signature state, so an
 * unsigned build can never be published with signed wording.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const report = JSON.parse(readFileSync(join(root, 'artifacts', 'build-report.json'), 'utf8'));
const highlightsPath = join(root, 'docs', 'releases', `${version}.md`);

if (!existsSync(highlightsPath)) {
  console.error(`Missing release highlights: ${highlightsPath}`);
  process.exit(1);
}

const highlights = readFileSync(highlightsPath, 'utf8').trim();
const prerelease = /-(alpha|beta)\./.test(version);

const signing = report.signed
  ? `This installer is **Authenticode-signed**. Publisher certificate:

\`${report.signer}\`

Windows verifies the signature and timestamp automatically. To check it yourself:

\`\`\`powershell
Get-AuthenticodeSignature .\\Meldrift-Setup.exe | Format-List Status, SignerCertificate
\`\`\`
`
  : `**This installer is unsigned.** No code-signing certificate is configured for
this build, so Windows SmartScreen or "Unknown publisher" warnings are expected.
The checksum below still lets you confirm that the file is exactly the one built
by this release job. Meldrift does not claim this build is signed.

To verify the download:

\`\`\`powershell
Get-FileHash .\\Meldrift-Setup.exe -Algorithm SHA256
\`\`\`

or:

\`\`\`bat
certutil -hashfile Meldrift-Setup.exe SHA256
\`\`\`
`;

const body = `# Meldrift ${version}

${prerelease ? "> **Prerelease.** This is an early alpha build: expect rough edges and keep backups of anything important.\n" : ""}
Windows 10/11 (64-bit) desktop app for voice, game streaming and host-approved
shared control.

## Highlights

${highlights}

## Install

1. Download \`Meldrift-Setup.exe\` and run it. It installs per user, so no
   administrator prompt is required.
2. It creates a Start Menu shortcut, optionally a desktop shortcut, and
   registers an uninstaller in **Apps & features**.
3. Application data stays in \`%APPDATA%\\com.meldrift.desktop\`. Uninstalling
   does not delete it.

The installer bootstraps the WebView2 runtime when it is missing.

## Integrity

SHA-256 of \`Meldrift-Setup.exe\`:

\`\`\`
${report.sha256}
\`\`\`

The same value is in \`SHA256SUMS.txt\`. The structured signature/version report
is in \`build-report.json\`.

## Signing

${signing}
## Notes

- Local mode bundles a signaling server, so rooms, chat and voice work on one
  PC with no setup. Playing across PCs needs one reachable server, run in
  Remote mode (\`docs/DEPLOYMENT.md\` in the source repository).
- Streaming is peer-to-peer for up to four viewers.
- Remote control is focus-based Win32 input injection, not a security sandbox.
- There is no auto-update in this build.
- Verification evidence and known limitations: \`docs/STATUS.md\` in the source
  repository.
`;

writeFileSync(join(root, 'artifacts', 'RELEASE_NOTES.md'), body, 'utf8');
console.log(`Wrote RELEASE_NOTES.md for ${version} (signed: ${report.signed})`);
