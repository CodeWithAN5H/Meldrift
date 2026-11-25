# Releasing Meldrift

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

`node scripts/check-version.mjs` fails the build if they drift, and also fails
when a pushed tag (`v0.1.0-alpha.1`) does not match the version.

## Local installer

```bash
bun install
bun run app:package
```

This runs `tsc`, Vite, the Rust release build, the NSIS bundler, then
`scripts/package.mjs`, which:

- validates the bundler output is a real Windows executable (MZ header, at
  least 1 MiB),
- copies it to **`artifacts/Meldrift-Setup.exe`**,
- writes `artifacts/SHA256SUMS.txt` and `artifacts/build-report.json`
  (the report records `signed: false` unless signing ran).

The NSIS installer is per-user (`currentUser`), so it installs without an
administrator prompt, registers in Apps & features, and can offer a desktop
shortcut. Application data lives in `%APPDATA%\com.meldrift.desktop` and is left
in place on uninstall unless the user removes it.

## Signing

Signing is optional and never faked:

```powershell
$env:SIGN_PFX_PATH = "C:\certs\meldrift.pfx"
$env:SIGN_PFX_PASSWORD = "..."
./scripts/sign.ps1
```

In GitHub Actions, add repository secrets `SIGN_PFX_BASE64` (base64 of the PFX)
and `SIGN_PFX_PASSWORD`. The release workflow decodes the certificate and signs
with `signtool` (SHA-256 + RFC 3161 timestamp). With no secrets, the build ships
unsigned and the release notes say so.

## Publishing

1. Update the six version files.
2. Commit, tag `v<version>`, push the tag.
3. `.github/workflows/release.yml` runs typecheck, Vitest, Rust tests, the
   release build and packaging. Any failure stops the job before upload, so a
   broken build can never be published.
4. The workflow uploads `Meldrift-Setup.exe`, `SHA256SUMS.txt` and
   `build-report.json`, then publishes a GitHub Release with generated notes and
   source archives.

Prerelease tags (`alpha`, `beta`) are marked as prereleases automatically.

## Manual test checklist before tagging

- [ ] Fresh install on Windows 10 and Windows 11.
- [ ] First run → onboarding → create room → send a message → restart → data intact.
- [ ] Mic check shows a moving level; mute and push-to-talk behave.
- [ ] Two clients join a room's voice: audio flows both ways, mute stops it,
      deafen mutes playback, speaking indicators follow real audio, leave and
      rejoin leave no duplicate peers, and a signaling restart recovers.
- [ ] Uninstall removes the app and shortcuts; data handling is as documented.
- [ ] Upgrade in place from the previous version.
