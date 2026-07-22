param(
    [string]$ConfigPath = "config/local.json",
    [switch]$CheckTasks
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath
$checks = New-Object System.Collections.Generic.List[object]
function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    $script:checks.Add([pscustomobject][ordered]@{ name = $Name; ok = $Ok; detail = $Detail }) | Out-Null
}

Add-Check "task-namespace" ([string]$config.taskName -like "BadmintonBookingAssistant_*") ([string]$config.taskName)
Add-Check "primary-campus" ([string]$config.primaryCampus -in @("lxd", "xlh")) ([string]$config.primaryCampus)
Add-Check "fallback-campus" ([string]$config.fallbackCampus -in @("lxd", "xlh", "auto") -and [string]$config.fallbackCampus -ne [string]$config.primaryCampus) ([string]$config.fallbackCampus)
Add-Check "fallback-retries" ([int]$config.fallbackAfterMisses -ge 1) ([string]$config.fallbackAfterMisses)
Add-Check "lxd-court-priority" (-not [string]::IsNullOrWhiteSpace([string]$config.lxdCourtPriority)) ([string]$config.lxdCourtPriority)
Add-Check "xlh-court-priority" (-not [string]::IsNullOrWhiteSpace([string]$config.xlhCourtPriority)) ([string]$config.xlhCourtPriority)
Add-Check "partial-fallback" (-not [bool]$config.disablePartialFallback -and [int]$config.partialMinMinutes -ge 60 -and [int]$config.partialFallbackAfterMisses -ge 1) ("minimum=" + $config.partialMinMinutes)
Add-Check "browser-mode" ([string]$config.browserMode -eq "webbridge") ([string]$config.browserMode)
Add-Check "payment-declared" ($null -ne $config.paymentAutoConfirm) ("autoConfirm=" + [bool]$config.paymentAutoConfirm)
Add-Check "mail-declared" ($null -ne $config.mailOnCompletion) ("enabled=" + [bool]$config.mailOnCompletion)

if ([bool]$config.mailOnCompletion) {
    $mailReady = -not [string]::IsNullOrWhiteSpace([string]$config.mailTo) -and -not [string]::IsNullOrWhiteSpace([string]$config.mailFrom) -and -not [string]::IsNullOrWhiteSpace([string]$config.smtpServer) -and [int]$config.smtpPort -gt 0
    Add-Check "mail-settings" $mailReady "Mail enabled fields."
} else {
    Add-Check "mail-settings" $true "Mail disabled; SMTP fields are optional."
}

if ($CheckTasks) {
    $taskName = [string]$config.taskName
    $expected = @(
        $taskName,
        $taskName + "_WebBridgePrestart",
        $taskName + "_VpnPreconnect",
        $taskName + "_Preflight",
        $taskName + "_Postcheck"
    )
    $installed = @()
    try { $installed = @(Get-ScheduledTask -TaskName ($taskName + "*") -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName) } catch { }
    foreach ($name in $expected) { Add-Check ("task:" + $name) ($name -in $installed) $(if ($name -in $installed) { "installed" } else { "missing" }) }
    Add-Check "task-count" ($installed.Count -eq 5) ("found=" + $installed.Count)
}

$failed = @($checks | Where-Object { -not $_.ok })
[ordered]@{
    ok = $failed.Count -eq 0
    checks = @($checks)
    failed = @($failed | Select-Object -ExpandProperty name)
} | ConvertTo-Json -Depth 8
if ($failed.Count) { exit 1 }
