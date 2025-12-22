<#
Generate a self-signed code-signing PFX, export base64, and optionally push to GitHub Secrets.
Run from repo root (PowerShell):
  .\scripts\generate-pfx-and-secrets.ps1

Warning: Do NOT commit cert.pfx or pfx.base64.txt into source control.
#>

param(
    [string]$CertSubject = "CN=CopyBoard Test",
    [int]$ValidYears = 1
)

function Read-PasswordPrompt($prompt) {
    Write-Host $prompt -NoNewline
    $secure = Read-Host -AsSecureString
    return $secure
}

# 1) Create self-signed certificate
Write-Host "Creating self-signed code-signing certificate..."
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $CertSubject -KeyExportPolicy Exportable -KeySpec Signature -HashAlgorithm sha256 -NotAfter (Get-Date).AddYears($ValidYears) -CertStoreLocation Cert:\CurrentUser\My
if (-not $cert) { Write-Error "Certificate creation failed."; exit 1 }
Write-Host "Certificate created: $($cert.Thumbprint)"

# 2) Export PFX
$pwdSecure = Read-PasswordPrompt "Enter password to protect the exported PFX (will not echo): "
$pwdPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwdSecure))
$pfxPath = Join-Path -Path (Get-Location) -ChildPath 'cert.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwdSecure -Force
Write-Host "Exported PFX to: $pfxPath"

# 3) Produce base64 and copy to clipboard and file
Write-Host "Converting PFX to base64..."
$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
$base64Path = Join-Path -Path (Get-Location) -ChildPath 'pfx.base64.txt'
$base64 | Out-File -Encoding ascii $base64Path -Force
Set-Clipboard -Value $base64
Write-Host "Base64 written to: $base64Path and copied to clipboard."

# 4) Optionally push to GitHub Secrets using gh CLI
$useGh = Read-Host "Do you want to set GitHub Actions secrets automatically using gh CLI? (y/N)"
if ($useGh -and $useGh.ToLower().StartsWith('y')) {
    # require gh
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Error "gh CLI not found. Install GitHub CLI and authenticate first: https://cli.github.com/"
    } else {
        $repo = Read-Host "Enter target repo (owner/repo)"
        if ([string]::IsNullOrWhiteSpace($repo)) { Write-Error "No repo provided, skipping gh upload." }
        else {
            Write-Host "Uploading secrets to $repo (PFX_BASE64 and PFX_PASSWORD)..."
            gh secret set PFX_BASE64 --body "$([IO.File]::ReadAllText($base64Path))" --repo $repo
            gh secret set PFX_PASSWORD --body "$pwdPlain" --repo $repo
            Write-Host "Secrets set in repository $repo. Verify in GitHub -> Settings -> Secrets and variables -> Actions"
        }
    }
}

# 5) Cleanup prompt
$doCleanup = Read-Host "Delete local cert.pfx and pfx.base64.txt now? (y/N)"
if ($doCleanup -and $doCleanup.ToLower().StartsWith('y')) {
    Remove-Item -Path $pfxPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $base64Path -Force -ErrorAction SilentlyContinue
    Write-Host "Local files deleted."
} else {
    Write-Host "Local files retained at: $pfxPath and $base64Path. Do NOT commit them."
}

Write-Host "Done. Next: push a tag (e.g. git tag v1.0.0 && git push --tags) to trigger workflow."
