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
    $script:checks.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail }) | Out-Null
}

Add-Check "clock" $true (Get-Date -Format "yyyy-MM-dd HH:mm:ss K")

try {
    $now = Get-Date
    $pollStart = Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.pollStartTime)
    $pollUntil = Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.pollUntilTime)
    $ok = $now -le $pollUntil
    $detail = "now=$($now.ToString('yyyy-MM-dd HH:mm:ss K')); runDate=$($runDateValue.ToString('yyyy-MM-dd')); targetDate=$($targetDateValue.ToString('yyyy-MM-dd')); pollStart=$($pollStart.ToString('yyyy-MM-dd HH:mm:ss')); pollUntil=$($pollUntil.ToString('yyyy-MM-dd HH:mm:ss'))"
    if (-not $ok) {
        $detail = "stale run; $detail"
    }
    Add-Check "run-window" $ok $detail
} catch {
    Add-Check "run-window" $false $_.Exception.Message
}

foreach ($file in @(
    (Join-Path $root "scripts\booking_logic.mjs"),
    (Join-Path $root "scripts\codex_plugin_runner.mjs"),
    (Join-Path $root "scripts\ui_server.mjs"),
    (Join-Path $root "scripts\webbridge_runner.mjs"),
    (Join-Path $root "scripts\send_booking_result_email.ps1"),
    (Join-Path $root "tools\common.ps1"),
    (Join-Path $root "tools\open-vpn.ps1"),
    (Join-Path $root "tools\start-ui-shortcut.ps1"),
    (Join-Path $root "tools\start-ui.ps1"),
    (Join-Path $root "tools\start-webbridge.ps1"),
    (Join-Path $root "tools\click-wechat-allow.ps1"),
    (Join-Path $root "tools\run-booking.ps1"),
    (Join-Path $root "tools\assert-success-profile.ps1"),
    (Join-Path $root "tools\install-next-formal-run.ps1"),
    (Join-Path $root "tools\postcheck.ps1"),
    (Join-Path $root "tools\install-task.ps1"),
    (Join-Path $root "tools\set-secret.ps1"),
    (Resolve-ProjectPath -Root $root -Path ([string]$config.passwordSecret)),
    (Resolve-ProjectPath -Root $root -Path ([string]$config.smtpSecret))
)) {
    Add-Check "file:$file" (Test-Path -LiteralPath $file) ""
    if ($file -like "*.ps1" -and (Test-Path -LiteralPath $file)) {
        try { Test-PowerShellSyntax -Path $file; Add-Check "syntax:$file" $true "" } catch { Add-Check "syntax:$file" $false $_.Exception.Message }
    }
    if ($file -like "*.mjs" -and (Test-Path -LiteralPath $file)) {
        try {
            & node --check $file | Out-Null
            Add-Check "syntax:$file" ($LASTEXITCODE -eq 0) "node --check"
        } catch {
            Add-Check "syntax:$file" $false $_.Exception.Message
        }
    }
}

foreach ($secret in @(
    @{ name = "passwordSecret"; path = [string]$config.passwordSecret },
    @{ name = "smtpSecret"; path = [string]$config.smtpSecret }
)) {
    try {
        $resolvedSecret = Resolve-ProjectPath -Root $root -Path ([string]$secret.path)
        $secretCheck = Test-DpapiSecret -Path $resolvedSecret -RequireNonEmpty
        Add-Check "secret-decrypt:$($secret.name)" $true "path=$resolvedSecret; length=$($secretCheck.length); user=$([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    } catch {
        Add-Check "secret-decrypt:$($secret.name)" $false "$($_.Exception.Message); user=$([System.Security.Principal.WindowsIdentity]::GetCurrent().Name); regenerate with tools\set-secret.ps1 under the same task user"
    }
}

try {
    $core = Get-Content -LiteralPath (Join-Path $root "scripts\booking_logic.mjs") -Raw
    $required = @(
        "selectSlotPageFunction",
        "venueStatePageFunction",
        "submitBookingPageFunction",
        "confirmPaymentPageFunction",
        "discountGetSiteList",
        "getSiteList",
        "partialMinMinutes",
        "paymentOutcome",
        "MembershipCardPaymentArr",
        "PatmentChange",
        "PatmentModel = `"hyk`"",
        "expectedShopNum",
        "campus card payment array not available",
        "clickedConfirmPayment"
    )
    $missing = @($required | Where-Object { $core -notlike "*$_*" })
    Add-Check "logic-guards" ($missing.Count -eq 0) $(if ($missing.Count) { "missing: $($missing -join ', ')" } else { "ok" })
} catch {
    Add-Check "logic-guards" $false $_.Exception.Message
}

try {
    $configOk = (
        [string]$config.primaryCampus -in @("xlh", "lxd") -and
        [string]$config.fallbackCampus -in @("xlh", "lxd", "auto", "none") -and
        [string]$config.browserMode -eq "webbridge" -and
        [string]$config.vpnLaunchMode -eq "explorer_shortcut" -and
        [int]$config.pollIntervalMs -le 300 -and
        [bool]$config.openVpn -and
        [bool]$config.mailOnCompletion -and
        -not [bool]$config.disablePartialFallback -and
        [int]$config.partialMinMinutes -ge 60 -and
        [int]$config.maxBookingMinutes -eq 90 -and
        [int]$config.maxBookingAmount -eq 15 -and
        ([string]$config.primaryCampus -ne "lxd" -or [int]$config.primaryCampusHoldSeconds -ge 10)
    )
    Add-Check "config-invariants" $configOk "browserMode=$($config.browserMode); expectedBrowserMode=webbridge; primary=$($config.primaryCampus); fallback=$($config.fallbackCampus); poll=$($config.pollIntervalMs); primaryHold=$($config.primaryCampusHoldSeconds)s; partial=$(-not [bool]$config.disablePartialFallback)/$($config.partialMinMinutes); maxMinutes=$($config.maxBookingMinutes); maxAmount=$($config.maxBookingAmount); vpn=$($config.openVpn); vpnLaunchMode=$($config.vpnLaunchMode); mail=$($config.mailOnCompletion)"
} catch {
    Add-Check "config-invariants" $false $_.Exception.Message
}

try {
    $openVpnContent = Get-Content -LiteralPath (Join-Path $root "tools\open-vpn.ps1") -Raw
    $ok = (
        $openVpnContent -like "*Opening EasyConnect via Start Menu shortcut; direct executable launch is avoided*" -and
        $openVpnContent -like "*explorer.exe*" -and
        $openVpnContent -like "*refusing direct executable launch*"
    )
    Add-Check "vpn-shortcut-launch-guard" $ok "open-vpn.ps1 uses Explorer + Start Menu shortcut path"
} catch {
    Add-Check "vpn-shortcut-launch-guard" $false $_.Exception.Message
}

try {
    $vpnState = Test-VpnAuthenticated
    $detail = "adapters=$($vpnState.adapters -join '; '); ips=$($vpnState.ips -join '; ')"
    Add-Check "vpn-authenticated-tunnel" ([bool]$vpnState.ok) $detail
} catch {
    Add-Check "vpn-authenticated-tunnel" $false $_.Exception.Message
}

$shortcutPath = [string]$config.easyConnectShortcutPath
Add-Check "file:easyconnect-shortcut" ($shortcutPath -and (Test-Path -LiteralPath $shortcutPath)) $shortcutPath

try {
    $runnerContent = Get-Content -LiteralPath (Join-Path $root "scripts\codex_plugin_runner.mjs") -Raw
    $required = @(
        "EasyConnect already running; leaving it untouched to avoid duplicate-launch anomaly",
        "Opening EasyConnect once via Start Menu shortcut; direct executable launch is avoided",
        "refusing direct executable/app-id EasyConnect launch"
    )
    $missing = @($required | Where-Object { $runnerContent -notlike "*$_*" })
    $forbidden = @()
    foreach ($pattern in @(
        'sky\.launch_app\(\{\s*app:\s*launchAppId',
        'Start-Process -FilePath \$ShortcutPath',
        'Start-Process -FilePath \$EasyConnectPath'
    )) {
        if ($runnerContent -match $pattern) { $forbidden += $pattern }
    }
    $ok = ($missing.Count -eq 0 -and $forbidden.Count -eq 0)
    $detail = "non-reentrant Start Menu shortcut launch guarded"
    if ($missing.Count) { $detail = "missing: $($missing -join ', ')" }
    if ($forbidden.Count) { $detail = "$detail; forbidden: $($forbidden -join ', ')" }
    Add-Check "vpn-launch-guard" $ok $detail
} catch {
    Add-Check "vpn-launch-guard" $false $_.Exception.Message
}

if ([string]$config.browserMode -eq "webbridge") {
    $webBridge = if ($env:KIMI_WEBBRIDGE_EXE) { $env:KIMI_WEBBRIDGE_EXE } else { Join-Path $env:USERPROFILE ".kimi-webbridge\bin\kimi-webbridge.exe" }
    Add-Check "file:kimi-webbridge" (Test-Path -LiteralPath $webBridge) $webBridge
    try {
        $statusText = & $webBridge status
        $status = $statusText | ConvertFrom-Json
        Add-Check "webbridge-status" ([bool]$status.running -and [bool]$status.extension_connected) $statusText
    } catch {
        Add-Check "webbridge-status" $false $_.Exception.Message
    }
} else {
    $pluginCacheRoot = if ($env:CODEX_PLUGIN_CACHE_ROOT) { $env:CODEX_PLUGIN_CACHE_ROOT } elseif ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME "plugins\cache" } else { Join-Path $env:USERPROFILE ".codex\plugins\cache" }
    $chromePluginClient = @(Get-ChildItem -LiteralPath $pluginCacheRoot -Recurse -Filter "browser-client.mjs" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\chrome\\" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName)
    $computerUseClient = @(Get-ChildItem -LiteralPath $pluginCacheRoot -Recurse -Filter "computer-use-client.mjs" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\computer-use\\" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName)
    Add-Check "file:codex-chrome-plugin-client" ([bool]$chromePluginClient -and (Test-Path -LiteralPath $chromePluginClient)) $(if ($chromePluginClient) { $chromePluginClient } else { "not found under $pluginCacheRoot" })
    Add-Check "file:computer-use-client" ([bool]$computerUseClient -and (Test-Path -LiteralPath $computerUseClient)) $(if ($computerUseClient) { $computerUseClient } else { "not found under $pluginCacheRoot" })
    try {
        $runnerContent = Get-Content -LiteralPath (Join-Path $root "scripts\codex_plugin_runner.mjs") -Raw
        $usesCodexPlugin = (
            $runnerContent -like "*setupBrowserRuntime*" -and
            $runnerContent -like "*browsers.get(`"extension`")*" -and
            $runnerContent -like "*setupComputerUseRuntime*"
        )
        Add-Check "codex-plugin-runtime-path" $usesCodexPlugin "requires Codex Chrome plugin extension plus Computer Use"
    } catch {
        Add-Check "codex-plugin-runtime-path" $false $_.Exception.Message
    }
}

try {
    $codexTasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like "CodexBadminton_*" -and $_.State -ne "Disabled" } | Select-Object -ExpandProperty TaskName)
    Add-Check "windows-booking-tasks" $true $(if ($codexTasks.Count) { $codexTasks -join "," } else { "none installed yet" })
    $formalTask = Get-ScheduledTask -TaskName ([string]$config.taskName) -ErrorAction SilentlyContinue
    if ($formalTask) {
        $actionText = (($formalTask.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join " ")
        Add-Check "formal-task-payment-enabled" ($actionText -notlike "*--noConfirmPayment*") $actionText
    }
} catch {
    Add-Check "windows-booking-task-inspection" $true "not inspected: $($_.Exception.Message)"
}

try {
    $nodeVersion = & node --version
    Add-Check "node" ($LASTEXITCODE -eq 0) $nodeVersion
} catch {
    Add-Check "node" $false $_.Exception.Message
}

$failed = @($checks | Where-Object { -not $_.ok })
$status = if ($failed.Count) { "FAIL" } else { "OK" }
$logPath = Join-Path $root ("logs\precheck_$RunKey.log")
$lines = @(
    "CodexBadminton precheck for target $($targetDateValue.ToString('yyyy-MM-dd'))",
    "Status: $status",
    "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')",
    "Execution model: $($config.browserMode)",
    ""
)
foreach ($check in $checks) {
    $lines += ("[{0}] {1} - {2}" -f ($(if ($check.ok) { "OK" } else { "FAIL" })), $check.name, $check.detail)
}
$lines | Set-Content -LiteralPath $logPath -Encoding UTF8
Get-Content -LiteralPath $logPath
if ($failed.Count) { exit 1 }
