param(
    [string]$ConfigPath = "config/local.json",
    [string]$ConfigJsonBase64 = "",
    [string]$RunDate = "",
    [string]$TargetDate = "",
    [string]$RunKey = "",
    [string]$FormalTaskName = "",
    [string]$PostcheckTaskNames = ""
)

$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath -ConfigJsonBase64 $ConfigJsonBase64
$runDateValue = Get-DateOnly -Value $RunDate -Default (Get-Date).Date.AddDays(1)
$targetDateValue = Get-DateOnly -Value $TargetDate -Default $runDateValue.AddDays(1)
if (-not $RunKey) { $RunKey = New-RunKey -RunDate $runDateValue -TargetDate $targetDateValue -Config $config }

$checks = New-Object System.Collections.Generic.List[object]
function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    $script:checks.Add([pscustomobject][ordered]@{ name = $Name; ok = $Ok; detail = $Detail }) | Out-Null
}

Add-Check "clock" $true (Get-Date -Format "yyyy-MM-dd HH:mm:ss K")

try {
    $now = Get-Date
    $pollUntil = Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.pollUntilTime)
    Add-Check "run-window" ($now -le $pollUntil) ("runDate=" + $runDateValue.ToString("yyyy-MM-dd") + "; targetDate=" + $targetDateValue.ToString("yyyy-MM-dd") + "; pollUntil=" + $pollUntil.ToString("yyyy-MM-dd HH:mm:ss"))
} catch {
    Add-Check "run-window" $false $_.Exception.Message
}

$requiredFiles = @(
    "badminton.ps1",
    "config\defaults.json",
    "scripts\booking_logic.mjs",
    "scripts\config_resolver.mjs",
    "scripts\webbridge_runner.mjs",
    "scripts\send_booking_result_email.ps1",
    "tools\common.ps1",
    "tools\open-vpn.ps1",
    "tools\start-webbridge.ps1",
    "tools\run-booking.ps1",
    "tools\postcheck.ps1",
    "tools\install-task.ps1"
)
foreach ($relative in $requiredFiles) {
    $file = Join-Path $root $relative
    $exists = Test-Path -LiteralPath $file -PathType Leaf
    Add-Check ("file:" + $relative) $exists $(if ($exists) { "present" } else { "missing" })
    if (-not $exists) { continue }
    if ($file -like "*.ps1") {
        try { Test-PowerShellSyntax -Path $file; Add-Check ("syntax:" + $relative) $true "PowerShell parser" } catch { Add-Check ("syntax:" + $relative) $false $_.Exception.Message }
    } elseif ($file -like "*.mjs") {
        & node --check $file 2>$null
        Add-Check ("syntax:" + $relative) ($LASTEXITCODE -eq 0) "node --check"
    }
}

try {
    $passwordPath = Resolve-ProjectPath -Root $root -Path ([string]$config.passwordSecret)
    $passwordCheck = Test-DpapiSecret -Path $passwordPath -RequireNonEmpty
    Add-Check "secret:booking-password" $true ("DPAPI decrypts; length=" + $passwordCheck.length)
} catch {
    Add-Check "secret:booking-password" $false $_.Exception.Message
}

if ([bool]$config.mailOnCompletion) {
    try {
        $smtpPath = Resolve-ProjectPath -Root $root -Path ([string]$config.smtpSecret)
        $smtpCheck = Test-DpapiSecret -Path $smtpPath -RequireNonEmpty
        Add-Check "secret:smtp" $true ("Mail enabled; DPAPI decrypts; length=" + $smtpCheck.length)
    } catch {
        Add-Check "secret:smtp" $false $_.Exception.Message
    }
} else {
    Add-Check "secret:smtp" $true "Mail disabled; SMTP secret is not required."
}

try {
    $validCampus = [string]$config.primaryCampus -in @("lxd", "xlh")
    $validFallback = [string]$config.fallbackCampus -in @("lxd", "xlh", "auto", "none") -and [string]$config.fallbackCampus -ne [string]$config.primaryCampus
    $priorityEnabled = -not [string]::IsNullOrWhiteSpace([string]$config.lxdCourtPriority) -and -not [string]::IsNullOrWhiteSpace([string]$config.xlhCourtPriority)
    $fallbackEnabled = [string]$config.fallbackCampus -ne "none" -and [int]$config.fallbackAfterMisses -ge 1
    $partialEnabled = -not [bool]$config.disablePartialFallback -and [int]$config.partialMinMinutes -ge 60 -and [int]$config.partialFallbackAfterMisses -ge 1
    $limitsOk = [int]$config.maxBookingMinutes -ge 60 -and [int]$config.maxBookingMinutes -le 120 -and [decimal]$config.maxBookingAmount -gt 0
    $taskScoped = [string]$config.taskName -like "BadmintonBookingAssistant_*"
    Add-Check "config:campus-fallback" ($validCampus -and $validFallback -and $fallbackEnabled) ("primary=" + $config.primaryCampus + "; fallback=" + $config.fallbackCampus + "; afterMisses=" + $config.fallbackAfterMisses)
    Add-Check "config:court-priority" $priorityEnabled "Both campus priority lists are non-empty."
    Add-Check "config:partial-fallback" $partialEnabled ("enabled=" + (-not [bool]$config.disablePartialFallback) + "; minimum=" + $config.partialMinMinutes)
    Add-Check "config:limits" $limitsOk ("minutes=" + $config.maxBookingMinutes + "; amount=" + $config.maxBookingAmount)
    Add-Check "config:task-scope" $taskScoped ([string]$config.taskName)
    Add-Check "config:payment" $true ("autoConfirm=" + [bool]$config.paymentAutoConfirm)
    Add-Check "config:mail" $true ("enabled=" + [bool]$config.mailOnCompletion)
} catch {
    Add-Check "config:invariants" $false $_.Exception.Message
}

if ([bool]$config.openVpn) {
    $shortcut = [string]$config.easyConnectShortcutPath
    Add-Check "vpn:shortcut" ($shortcut -and (Test-Path -LiteralPath $shortcut -PathType Leaf)) $(if ($shortcut) { "discovered" } else { "not found" })
    try {
        $vpnState = Test-VpnAuthenticated
        Add-Check "vpn:tunnel" ([bool]$vpnState.ok) $(if ($vpnState.ok) { "authenticated" } else { "not authenticated" })
    } catch {
        Add-Check "vpn:tunnel" $false $_.Exception.Message
    }
} else {
    Add-Check "vpn:shortcut" $true "VPN launch disabled by advanced configuration."
}

if ([string]$config.browserMode -eq "webbridge") {
    $bridge = [string]$config.webBridgeExecutablePath
    Add-Check "webbridge:executable" ($bridge -and (Test-Path -LiteralPath $bridge -PathType Leaf)) $(if ($bridge) { "configured" } else { "not configured" })
    if ($bridge -and (Test-Path -LiteralPath $bridge -PathType Leaf)) {
        try {
            $statusText = & $bridge status 2>$null
            $status = $statusText | ConvertFrom-Json
            Add-Check "webbridge:connection" ([bool]$status.running -and [bool]$status.extension_connected) "service and browser extension"
        } catch {
            Add-Check "webbridge:connection" $false $_.Exception.Message
        }
    }
} else {
    Add-Check "webbridge:mode" $false ("Unsupported public scheduler browserMode=" + [string]$config.browserMode)
}

try {
    $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "BadmintonBookingAssistant_*" } | Select-Object -ExpandProperty TaskName)
    Add-Check "tasks:project-scope" $true $(if ($tasks.Count) { $tasks -join "," } else { "none installed" })
} catch {
    Add-Check "tasks:project-scope" $true "Task Scheduler inspection unavailable."
}

$failed = @($checks | Where-Object { -not $_.ok })
$status = if ($failed.Count) { "FAIL" } else { "OK" }
$logDir = Join-Path $root "logs"
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir ("precheck_" + $RunKey + ".log")
$lines = @(
    "Badminton Booking Assistant precheck for target " + $targetDateValue.ToString("yyyy-MM-dd"),
    "Status: " + $status,
    "Generated: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss K"),
    ""
)
foreach ($check in $checks) {
    $label = if ($check.ok) { "OK" } else { "FAIL" }
    $lines += ("[" + $label + "] " + $check.name + " - " + $check.detail)
}
$lines | Set-Content -LiteralPath $logPath -Encoding UTF8
Get-Content -LiteralPath $logPath
if ($failed.Count) { exit 1 }
