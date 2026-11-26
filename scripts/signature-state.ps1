# Reports the Authenticode state of one file as compact JSON.
# Used by scripts/package.mjs and scripts/verify-release.mjs so the build report
# always reflects the real signature rather than an assumption.

param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
  throw "File not found: $Path"
}

$signature = Get-AuthenticodeSignature -LiteralPath $Path
$signer = $null
if ($signature.SignerCertificate) {
  $signer = $signature.SignerCertificate.Subject
}

[pscustomobject]@{
  status = $signature.Status.ToString()
  signer = $signer
} | ConvertTo-Json -Compress
