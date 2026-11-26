# Releasing Meldrift

## Current release status (2026-11-26)

- Latest prepared version: **`0.7.0-alpha.1`**, Windows 10/11 64-bit.
- The installer is **unsigned**. No code-signing certificate and no
  `SIGN_PFX_BASE64` / `SIGN_PFX_PASSWORD` repository secrets are configured.
- The release workflow is implemented and validated for the unsigned path. It
  signs automatically once those two secrets exist.
- Pushing a version tag publishes the release, but only after the entire
  build, test, checksum and verification path has succeeded. The four assets
  are attached to a draft first and that same draft is then published, so a
  failed upload cannot leave an incomplete public release.

Meldrift never labels an unsigned build as signed.

## Versioning

Semantic versioning with prerelease tags:

```
0.1.0-alpha.1  →  0.1.0-alpha.2  →  0.1.0-beta.1  →  1.0.0
```

The version appears in six files and must match everywhere:

1. `package.json`
2. `server/package.json`
3. `src-tauri/tauri.conf.json`
4. `src-tauri/Cargo.toml`
5. `src-tauri/Cargo.lock` (the `meldrift` package entry)
6. `src/lib/version.ts`

`node scripts/check-version.mjs` fails when they drift. It also validates the
release tag: only `v<version>` is accepted, with an optional
`-alpha.N`/`-beta.N` prerelease suffix, and the tag must equal the version.

Every release also needs a highlights file: `docs/releases/<version>.md`. The
release job fails if it is missing.

## Creating a release

1. Bump the six version files and add `docs/releases/<version>.md`.
2. Run the local checks:
   ```bash
   bun run typecheck && bun run test
   cd server && bun test && cd ..
   cargo test --manifest-path src-tauri/Cargo.toml
   bun run app:package
   node scripts/verify-release.mjs
   ```
3. Commit and push `main`.
4. Create and push the tag:
   ```bash
   git tag v0.7.0-alpha.1
   git push origin v0.7.0-alpha.1
   ```
5. `.github/workflows/release.yml` runs on the tag. It:
   - checks out exactly that tag,
   - validates the tag format and version consistency,
   - installs app and server dependencies,
   - runs typecheck, frontend tests, server tests and Rust tests,
   - builds the release executable without bundling,
   - signs the executable and then the installer when signing is configured,
   - bundles the NSIS installer (without re-patching the signed executable),
   - packages `Meldrift-Setup.exe`, records the real Authenticode state and
     computes the SHA-256 of that exact file,
   - generates `RELEASE_NOTES.md`,
   - re-verifies version, PE header, checksum, signature and notes,
   - uploads the four assets to a **draft** GitHub Release, then publishes that
     same draft (marked as a prerelease for an `alpha`/`beta` version).
6. Watch the run. Any failed step stops before publication; fix the problem,
   push to `main` and re-create the tag. Confirm the release page shows the
   installer, `SHA256SUMS.txt`, `build-report.json`, the release notes and the
   prerelease label.

### Validating without publishing

Run **Actions → Release → Run workflow** with:

- `tag`: an existing tag, for example `v0.7.0-alpha.1`
- `publish`: **false**

This performs the complete build, signing, checksum and verification path and
uploads `meldrift-windows-installer` as a workflow artifact, but creates no
GitHub Release. Use this before pushing a tag when preparing a release.

### Publishing deliberately

Run the same workflow with `publish: true` on an existing tag to rebuild and
re-publish (or update) that tag's release. Publishing an already-uploaded draft
from the GitHub UI is equally valid and does not rebuild anything.

A manual run with `publish: false` never creates or publishes a release.

## Signing

### What gets signed

1. `src-tauri/target/release/meldrift.exe` after `tauri build --no-bundle`.
2. The NSIS installer after `tauri bundle --no-binary-patching`.

The signed executable is bundled unchanged, so the installed application keeps
its signature. The installer itself is signed afterwards and its SHA-256 is
computed from the final signed file. `bun run tauri build` alone would re-patch
the executable and invalidate the signature, which is why the release job uses
the two-stage build.

### Certificate requirements

- An Authenticode code-signing certificate from a publicly trusted CA.
- Exported as a password-protected `.pfx` (PKCS#12) including the private key.
- SHA-256 digest and an RFC 3161 timestamp (`http://timestamp.digicert.com`).
- The certificate's subject becomes the publisher shown by Windows.

EV certificates and hardware-token certificates cannot be used through a PFX
secret. For those, sign locally with the token and verify the resulting
installer, or use a cloud signing service; do not weaken the pipeline.

### GitHub repository secrets

Add both in **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `SIGN_PFX_BASE64` | Base64 of the `.pfx` file (one line, no header) |
| `SIGN_PFX_PASSWORD` | The `.pfx` password |

Create the base64 value without printing it:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\certs\meldrift.pfx")) |
  Set-Clipboard
```

Paste it into the secret field and clear the clipboard. Never commit the PFX,
its password, or the base64 value. The workflow decodes the certificate into
`RUNNER_TEMP`, signs, and never prints the password or certificate contents.

### Local signing

```powershell
$env:SIGN_PFX_PATH = "C:\certs\meldrift.pfx"
$env:SIGN_PFX_PASSWORD = "..."
./scripts/sign.ps1 -Path "src-tauri\target\release\meldrift.exe" -Require
bun run tauri bundle --no-binary-patching --no-sign
./scripts/sign.ps1 -Require
node scripts/package.mjs
node scripts/release-notes.mjs
node scripts/verify-release.mjs
```

### Verifying a signature

```powershell
Get-AuthenticodeSignature .\Meldrift-Setup.exe | Format-List Status, SignerCertificate
```

`Status` must be `Valid`. `build-report.json` records `signed`, the
`signtool`-verified `signatureStatus` and the signer subject. When signing
secrets are configured, the workflow sets `MELDRIFT_REQUIRE_SIGNING=1`; a
missing, invalid or untrusted signature then fails the job instead of quietly
producing an unsigned release.

Without a certificate, `scripts/sign.ps1` prints `BLOCKED` and exits 0 unless
signing is required. It never invents or fabricates a signature.

## Checksums

`SHA256SUMS.txt` contains one line and is generated from the exact installer
that is uploaded:

```
<sha256>  Meldrift-Setup.exe
```

Users can verify it with:

```powershell
Get-FileHash .\Meldrift-Setup.exe -Algorithm SHA256
```

or `certutil -hashfile Meldrift-Setup.exe SHA256`. `verify-release.mjs` fails
the release if the file, the checksum, the build report, the PE version resource
or the signature state disagree.

## Unsigned builds

Without signing credentials, releases ship **unsigned**. Windows SmartScreen
may show "Unknown publisher", and the release notes explicitly say the build is
unsigned. The checksum is still meaningful: it proves the download matches the
artifact this workflow built. Do not tell users an unsigned build is signed or
"certified".

## Release assets

| Asset | Purpose |
| --- | --- |
| `Meldrift-Setup.exe` | NSIS per-user installer |
| `SHA256SUMS.txt` | Checksum of the exact installer |
| `build-report.json` | Version, size, checksum and real signature state |
| `RELEASE_NOTES.md` | Same notes shown on the GitHub Release |

## Recovering from a failed release

- **Before any release exists:** the job fails, nothing is uploaded. Fix the
  problem, push to `main`, then re-run the workflow for the same tag (or create
  a new version if the tag itself must change).
- **A draft exists and is wrong:** delete the draft release, fix the code, and
  re-run the workflow on the tag. Publishing is still blocked until you
  explicitly publish.
- **Signing fails when secrets are configured:** the job fails and no release is
  published. Check the certificate's validity, password, timestamp service
  availability and `signtool` presence. Do not disable signing to "get past" it
  while the secrets are configured.
- **A public release is wrong:** do not silently replace assets. Prefer a new
  patch/prerelease version. If the release must be withdrawn, mark it as a draft
  or delete it, then publish a corrected version with a new tag. Avoid moving an
  already-published tag.
- **Tag does not match:** `check-version.mjs` fails before building. The tag
  must be `v<version>` exactly.

## Manual test checklist before tagging

- [ ] Fresh install on Windows 10 and Windows 11.
- [ ] First run → onboarding → create room → send a message → restart → data intact.
- [ ] Mic check shows a moving level; mute and push-to-talk behave.
- [ ] Two clients join a room's voice: audio flows both ways, mute stops it,
      deafen mutes playback, speaking indicators follow real audio, leave and
      rejoin leave no duplicate peers, and a signaling restart recovers.
- [ ] Installer launches a visible window on every launch (including after
      upgrade and after a hard kill).
- [ ] Signature status, publisher and timestamp are correct (signed builds only).
- [ ] `SHA256SUMS.txt` matches the installer.
- [ ] Uninstall removes the app and shortcuts; `%APPDATA%\com.meldrift.desktop`
      is left in place.
- [ ] Upgrade in place from the previous version.
