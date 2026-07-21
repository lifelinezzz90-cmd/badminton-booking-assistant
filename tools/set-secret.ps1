param(
    [Parameter(Mandatory)][string]$Path,
    [string]$Prompt = "Enter secret",
    [switch]$Verify
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$resolved = Resolve-ProjectPath -Root $root -Path $Path
$dir = Split-Path -Parent $resolved
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$secure = Read-Host -Prompt $Prompt -AsSecureString
$encrypted = $secure | ConvertFrom-SecureString
if ([string]::IsNullOrWhiteSpace($encrypted)) {
    throw "ConvertFrom-SecureString returned an empty value."
}
[System.IO.File]::WriteAllText($resolved, $encrypted, [System.Text.Encoding]::ASCII)

Write-Host "Secret written for current Windows logon context: $resolved"
if ($Verify) {
    $check = Test-DpapiSecret -Path $resolved -RequireNonEmpty
    Write-Host "Verified DPAPI decryptability. Length=$($check.length)"
}
