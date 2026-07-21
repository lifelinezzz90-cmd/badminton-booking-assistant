param(
    [string]$ConfigPath = "config/local.json",
    [Parameter(Mandatory)][string]$RunDate,
    [Parameter(Mandatory)][string]$TargetDate,
    [Parameter(Mandatory)][string]$RunKey
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$precheck = Join-Path $PSScriptRoot "precheck.ps1"
$resolvedConfig = Resolve-ProjectPath -Root $root -Path $ConfigPath
$outLog = Join-Path $logDir "scheduled_precheck_${RunKey}.out.log"
$errLog = Join-Path $logDir "scheduled_precheck_${RunKey}.err.log"

Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue

$args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $precheck,
    "-ConfigPath", $resolvedConfig,
    "-RunDate", $RunDate,
    "-TargetDate", $TargetDate,
    "-RunKey", $RunKey
)

Push-Location $root
try {
    & powershell.exe @args > $outLog 2> $errLog
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
