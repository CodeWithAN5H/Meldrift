# Authenticode signing for the NSIS installer.
#
# Only runs when a certificate is supplied. Meldrift never claims an unsigned
# build is signed: scripts/package.mjs records `signed: false` and the release
# notes state it explicitly.
#
# Usage (CI or local):
#   $env:SIGN_PFX_PATH = "C:\certs\meldrift.pfx"
#   $env:SIGN_PFX_PASSWORD = "..."
#   ./scripts/sign.ps1

$ErrorActionPreference = "Stop"

$pfx = $env:SIGN_PFX_PATH
$password = $env:SIGN_PFX_PASSWORD
$target = Join-Path (Get-Location) "artifacts\Meldrift-Setup.exe"

if ([string]::IsNullOrWhiteSpace($pfx) -or [string]::IsNullOrWhiteSpace($password)) {
  Write-Output "No signing certificate configured; leaving the installer unsigned."
  exit 0
}

if (-not (Test-Path $target)) {
  throw "Installer not found at $target. Run gem 'bun run app:package' first."
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
  Where-Object { $_.FullName -match "x64" } |
  Select-Object -First 1

if (-not $signtool) {
  throw "signtool.exe not found. Install the Windows SDK signing tools."
}

& $signtool.FullName sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $pfx /p $password $target
if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }

& $signtool.FullName verify /pa $target
Write-Output "Installer signed and verified."
