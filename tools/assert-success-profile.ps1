param(
    [string]$ConfigPath = "config/local.json",
    [switch]$CheckTasks,
    [switch]$FlexibleVariables,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath
$checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    $script:checks.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail }) | Out-Null
}

function Get-PropString {
    param($Object, [string]$Name)
    if ($null -eq $Object.PSObject.Properties[$Name]) { return "" }
    return [string]$Object.$Name
}

function Get-PropInt {
    param($Object, [string]$Name, [int]$Default = 0)
    if ($null -eq $Object.PSObject.Properties[$Name]) { return $Default }
    return [int]$Object.$Name
}

function Get-PropBool {
    param($Object, [string]$Name, [bool]$Default = $false)
    if ($null -eq $Object.PSObject.Properties[$Name]) { return $Default }
    return [bool]$Object.$Name
}

$resolvedConfigPath = Resolve-ProjectPath -Root $root -Path $ConfigPath
Add-Check "config:file" (Test-Path -LiteralPath $resolvedConfigPath) $resolvedConfigPath

$startMinutes = 0
$endMinutes = 0
function Convert-TimeToMinutes {
    param([string]$TimeText)
    if ($TimeText -notmatch '^(\d{1,2}):(\d{2})$') { return -1 }
    return ([int]$matches[1] * 60) + [int]$matches[2]
}
$startMinutes = Convert-TimeToMinutes -TimeText (Get-PropString $config "desiredStartTime")
$endMinutes = Convert-TimeToMinutes -TimeText (Get-PropString $config "desiredEndTime")
$baseGuardsOk = (
    (Get-PropString $config "browserMode") -eq "webbridge" -and
    (Get-PropString $config "primaryCampus") -in @("lxd", "xlh") -and
    (Get-PropString $config "fallbackCampus") -in @("lxd", "xlh", "none", "auto") -and
    $startMinutes -ge 480 -and
    $endMinutes -gt $startMinutes -and
    $endMinutes -le 1320 -and
    (($endMinutes - $startMinutes) % 30) -eq 0 -and
    (Get-PropInt $config "maxBookingMinutes") -ge 60 -and
    (Get-PropInt $config "maxBookingMinutes") -le 120 -and
    (Get-PropInt $config "maxBookingAmount") -gt 0 -and
    (Get-PropInt $config "partialMinMinutes") -ge 60 -and
    -not (Get-PropBool $config "disablePartialFallback") -and
    (Get-PropString $config "pollStartTime") -eq "07:58:00" -and
    (Get-PropString $config "pollUntilTime") -eq "08:08:00" -and
    (Get-PropInt $config "pollIntervalMs") -le 100 -and
    (Get-PropInt $config "primaryCampusHoldSeconds") -ge 15 -and
    (Get-PropBool $config "openVpn") -and
    (Get-PropString $config "vpnLaunchMode") -eq "explorer_shortcut" -and
    (Get-PropBool $config "mailOnCompletion")
)
$strictVariablesOk = (
    (Get-PropString $config "primaryCampus") -eq "lxd" -and
    (Get-PropString $config "fallbackCampus") -eq "xlh" -and
    (Get-PropString $config "desiredStartTime") -eq "19:00" -and
    (Get-PropString $config "desiredEndTime") -eq "21:00" -and
    (Get-PropInt $config "maxBookingMinutes") -eq 90 -and
    (Get-PropInt $config "maxBookingAmount") -eq 15
)
$profileOk = $baseGuardsOk -and ($FlexibleVariables -or $strictVariablesOk)
Add-Check "config:proven-success-profile" $profileOk (
    "browserMode=$($config.browserMode); primary=$($config.primaryCampus); fallback=$($config.fallbackCampus); " +
    "time=$($config.desiredStartTime)-$($config.desiredEndTime); maxMinutes=$($config.maxBookingMinutes); " +
    "maxAmount=$($config.maxBookingAmount); partialMin=$($config.partialMinMinutes); flexibleVariables=$([bool]$FlexibleVariables); poll=$($config.pollStartTime)-$($config.pollUntilTime)/$($config.pollIntervalMs)ms; " +
    "primaryHold=$($config.primaryCampusHoldSeconds); vpn=$($config.openVpn)/$($config.vpnLaunchMode); mail=$($config.mailOnCompletion)"
)

foreach ($path in @(
    "scripts\booking_logic.mjs",
    "scripts\webbridge_runner.mjs",
    "scripts\send_booking_result_email.ps1",
    "tools\common.ps1",
    "tools\open-vpn.ps1",
    "tools\start-webbridge.ps1",
    "tools\install-task.ps1",
    "tools\postcheck.ps1"
)) {
    $full = Join-Path $root $path
    Add-Check "file:$path" (Test-Path -LiteralPath $full) $full
}

try {
    $shortcutPath = Get-PropString $config "easyConnectShortcutPath"
    Add-Check "vpn:shortcut" ($shortcutPath -and (Test-Path -LiteralPath $shortcutPath)) $shortcutPath
} catch {
    Add-Check "vpn:shortcut" $false $_.Exception.Message
}

try {
    $openVpn = Get-Content -LiteralPath (Join-Path $root "tools\open-vpn.ps1") -Raw
    $ok = (
        $openVpn -like "*Opening EasyConnect via Start Menu shortcut; direct executable launch is avoided*" -and
        $openVpn -like "*explorer.exe*" -and
        $openVpn -like "*refusing direct executable launch*"
    )
    Add-Check "vpn:non-reentrant-shortcut-path" $ok "open-vpn.ps1 uses Explorer + Start Menu shortcut path"
} catch {
    Add-Check "vpn:non-reentrant-shortcut-path" $false $_.Exception.Message
}

try {
    $runBooking = Get-Content -LiteralPath (Join-Path $root "tools\run-booking.ps1") -Raw
    $ok = (
        $runBooking -match '\$runnerConfigPath\s*=\s*if\s*\(\$ConfigJsonBase64\)' -and
        $runBooking -match 'Write-JsonFile\s+-Value\s+\(ConvertTo-Hashtable\s+-Object\s+\$config\)\s+-Path\s+\$runnerConfigPath' -and
        $runBooking -match '"--config",\s*\$runnerConfigPath'
    )
    Add-Check "wrapper:embedded-config-forwarding" $ok "Task Scheduler embedded config is written to an effective config file and passed to Node runner."
} catch {
    Add-Check "wrapper:embedded-config-forwarding" $false $_.Exception.Message
}

try {
    $runner = Get-Content -LiteralPath (Join-Path $root "scripts\webbridge_runner.mjs") -Raw
    $required = @(
        "partialFallbackStart",
        "primaryCampusHoldSeconds",
        "configuredBeforeOpen",
        "maxBookingAmount",
        "Recovered on confirmPayment page after WebBridge failure",
        "Retryable submit/payment failure",
        "returning to slot polling"
    )
    $missing = @($required | Where-Object { $runner -notlike "*$_*" })
    Add-Check "runner:success-path-guards" ($missing.Count -eq 0) $(if ($missing.Count) { "missing: $($missing -join ', ')" } else { "ok" })
} catch {
    Add-Check "runner:success-path-guards" $false $_.Exception.Message
}

if ($CheckTasks) {
    try {
        $taskName = Get-PropString $config "taskName"
        if (-not $taskName) { $taskName = "CodexBadminton_LXD_1900_2100" }
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $task) {
            Add-Check "task:booking-installed" $false "missing task $taskName"
        } else {
            $actionText = (($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join " ")
            $expectedConfigPath = Resolve-ProjectPath -Root $root -Path $ConfigPath
            $hasExpectedConfig = $actionText -like "*$expectedConfigPath*"
            if (-not $hasExpectedConfig) {
                $quotedConfigJsonMatch = [regex]::Match($actionText, '-ConfigJsonBase64\s+"([^"]+)"')
                $plainConfigJsonMatch = [regex]::Match($actionText, '-ConfigJsonBase64\s+(\S+)')
                if ($quotedConfigJsonMatch.Success -or $plainConfigJsonMatch.Success) {
                    try {
                        $currentConfigJsonBase64 = if ($quotedConfigJsonMatch.Success) { $quotedConfigJsonMatch.Groups[1].Value } else { $plainConfigJsonMatch.Groups[1].Value }
                        $embedded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($currentConfigJsonBase64)) | ConvertFrom-Json
                        $hasExpectedConfig = (
                            (Get-PropString $embedded "primaryCampus") -eq (Get-PropString $config "primaryCampus") -and
                            (Get-PropString $embedded "fallbackCampus") -eq (Get-PropString $config "fallbackCampus") -and
                            (Get-PropString $embedded "desiredStartTime") -eq (Get-PropString $config "desiredStartTime") -and
                            (Get-PropString $embedded "desiredEndTime") -eq (Get-PropString $config "desiredEndTime") -and
                            (Get-PropInt $embedded "maxBookingMinutes") -eq (Get-PropInt $config "maxBookingMinutes") -and
                            ([decimal](Get-PropString $embedded "maxBookingAmount")) -eq ([decimal](Get-PropString $config "maxBookingAmount")) -and
                            (Get-PropInt $embedded "partialMinMinutes") -eq (Get-PropInt $config "partialMinMinutes") -and
                            (Get-PropBool $embedded "mailOnCompletion") -eq (Get-PropBool $config "mailOnCompletion") -and
                            (Get-PropString $embedded "browserMode") -eq (Get-PropString $config "browserMode")
                        )
                    } catch {
                        $hasExpectedConfig = $false
                    }
                }
            }
            Add-Check "task:booking-action" (
                ($actionText -like "*run-booking.ps1*" -or $actionText -like "*webbridge_runner.mjs*") -and
                $hasExpectedConfig -and
                $actionText -notlike "*NoConfirmPayment*"
            ) $actionText
        }
        foreach ($suffix in @("WebBridgePrestart", "VpnPreconnect", "Preflight", "Postcheck")) {
            $supportName = "${taskName}_${suffix}"
            $support = Get-ScheduledTask -TaskName $supportName -ErrorAction SilentlyContinue
            Add-Check "task:$suffix" ($null -ne $support) $supportName
        }
        $taskPathCandidates = New-Object System.Collections.Generic.List[string]
        $taskPathPattern = '(?i)([A-Z]:\\[^"]+\.(?:exe|mjs|ps1|json|lnk))'
        foreach ($scheduledTask in @(Get-ScheduledTask -TaskName "CodexBadminton*" -ErrorAction SilentlyContinue)) {
            foreach ($action in @($scheduledTask.Actions)) {
                $scheduledActionText = "$($action.Execute) $($action.Arguments)"
                foreach ($match in [regex]::Matches($scheduledActionText, $taskPathPattern)) {
                    $taskPathCandidates.Add($match.Groups[1].Value) | Out-Null
                }
            }
        }
        $taskPaths = @($taskPathCandidates | Sort-Object -Unique)
        $missingTaskPaths = @($taskPaths | Where-Object { -not (Test-Path -LiteralPath $_) })
        $taskPathDetail = if ($missingTaskPaths.Count) {
            "missing: $($missingTaskPaths -join '; ')"
        } elseif ($taskPaths.Count) {
            "checked $($taskPaths.Count) action paths"
        } else {
            "no CodexBadminton scheduled tasks found"
        }
        Add-Check "task:action-paths-exist" ($missingTaskPaths.Count -eq 0) $taskPathDetail
    } catch {
        Add-Check "task:inspection" $false $_.Exception.Message
    }
}

$failed = @($checks | Where-Object { -not $_.ok })
if (-not $Quiet) {
    foreach ($check in $checks) {
        "{0} {1} {2}" -f ($(if ($check.ok) { "OK" } else { "FAIL" })), $check.name, $check.detail
    }
}
if ($failed.Count) {
    exit 1
}
