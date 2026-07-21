param([string]$ConfigPath = "config/local.json")

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath
$checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    $script:checks.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail }) | Out-Null
}

foreach ($path in @(
    "web\app.js",
    "scripts\booking_logic.mjs",
    "scripts\codex_plugin_runner.mjs",
    "scripts\ui_server.mjs",
    "scripts\webbridge_runner.mjs",
    "scripts\send_booking_result_email.ps1",
    "scripts\send_status_email.ps1",
    "tools\common.ps1",
    "tools\open-vpn.ps1",
    "tools\start-ui-shortcut.ps1",
    "tools\start-ui.ps1",
    "tools\start-webbridge.ps1",
    "tools\run-booking.ps1",
    "tools\install-task.ps1",
    "tools\install-next-formal-run.ps1",
    "tools\assert-success-profile.ps1",
    "tools\run-mail-smoke.ps1",
    "tools\test-scheduled-mail.ps1",
    "tools\test-scheduled-wrapper.ps1",
    "tools\precheck.ps1",
    "tools\postcheck.ps1"
)) {
    $full = Join-Path $root $path
    try {
        if ($path -like "*.ps1") {
            Test-PowerShellSyntax -Path $full
        } elseif ($path -like "*.mjs" -or $path -like "*.js") {
            & node --check $full | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE" }
        }
        Add-Check "syntax:$path" $true ""
    } catch {
        Add-Check "syntax:$path" $false $_.Exception.Message
    }
}

foreach ($path in @([string]$config.passwordSecret, [string]$config.smtpSecret)) {
    $full = Resolve-ProjectPath -Root $root -Path $path
    try {
        $secretCheck = Test-DpapiSecret -Path $full -RequireNonEmpty
        Add-Check "secret:$path" $true "decryptable length=$($secretCheck.length)"
    } catch {
        Add-Check "secret:$path" $false $_.Exception.Message
    }
}

$core = Get-Content -LiteralPath (Join-Path $root "scripts\booking_logic.mjs") -Raw
$requiredCore = @(
    "selectSlotPageFunction",
    "submitBookingPageFunction",
    "confirmPaymentPageFunction",
    "discountGetSiteList",
    "getSiteList",
    "partialMinMinutes",
    "paymentOutcome"
)
$missingCore = @($requiredCore | Where-Object { $core -notlike "*$_*" })
Add-Check "core:mvp-guards" ($missingCore.Count -eq 0) $(if ($missingCore.Count) { "missing: $($missingCore -join ', ')" } else { "ok" })

$runner = Get-Content -LiteralPath (Join-Path $root "scripts\codex_plugin_runner.mjs") -Raw
$requiredRunner = @(
    "EasyConnect already running; leaving it untouched to avoid duplicate-launch anomaly",
    "Opening EasyConnect once via Start Menu shortcut; direct executable launch is avoided",
    "refusing direct executable/app-id EasyConnect launch"
)
$missingRunner = @($requiredRunner | Where-Object { $runner -notlike "*$_*" })
$forbiddenRunner = @()
foreach ($pattern in @(
    'sky\.launch_app\(\{\s*app:\s*launchAppId',
    'Start-Process -FilePath \$ShortcutPath',
    'Start-Process -FilePath \$EasyConnectPath'
)) {
    if ($runner -match $pattern) { $forbiddenRunner += $pattern }
}
$runnerOk = ($missingRunner.Count -eq 0 -and $forbiddenRunner.Count -eq 0)
$runnerDetail = "non-reentrant Start Menu shortcut launch guarded"
if ($missingRunner.Count) { $runnerDetail = "missing: $($missingRunner -join ', ')" }
if ($forbiddenRunner.Count) { $runnerDetail = "$runnerDetail; forbidden: $($forbiddenRunner -join ', ')" }
Add-Check "runner:vpn-launch-guard" $runnerOk $runnerDetail

$openVpn = Get-Content -LiteralPath (Join-Path $root "tools\open-vpn.ps1") -Raw
$openVpnOk = (
    $openVpn -like "*Opening EasyConnect via Start Menu shortcut; direct executable launch is avoided*" -and
    $openVpn -like "*explorer.exe*" -and
    $openVpn -like "*refusing direct executable launch*"
)
Add-Check "open-vpn:shortcut-launch-guard" $openVpnOk "Explorer opens the Start Menu shortcut; direct executable launch remains refused"

$runBooking = Get-Content -LiteralPath (Join-Path $root "tools\run-booking.ps1") -Raw
$wrapperForwardOk = (
    $runBooking -match '\$runnerConfigPath\s*=\s*if\s*\(\$ConfigJsonBase64\)' -and
    $runBooking -match 'Write-JsonFile\s+-Value\s+\(ConvertTo-Hashtable\s+-Object\s+\$config\)\s+-Path\s+\$runnerConfigPath' -and
    $runBooking -match '"--config",\s*\$runnerConfigPath'
)
Add-Check "wrapper:embedded-config-forwarding" $wrapperForwardOk "Task Scheduler embedded config is written to an effective config file and passed to Node runner."

$webBridgeRunner = Get-Content -LiteralPath (Join-Path $root "scripts\webbridge_runner.mjs") -Raw
$requiredWebBridgeRunner = @(
    "partialFallbackStart",
    "primaryCampusHoldSeconds",
    "configuredBeforeOpen",
    "maxBookingAmount",
    "Recovered on confirmPayment page after WebBridge failure",
    "Retryable submit/payment failure",
    "returning to slot polling"
)
$missingWebBridgeRunner = @($requiredWebBridgeRunner | Where-Object { $webBridgeRunner -notlike "*$_*" })
Add-Check "webbridge-runner:success-path-guards" ($missingWebBridgeRunner.Count -eq 0) $(if ($missingWebBridgeRunner.Count) { "missing: $($missingWebBridgeRunner -join ', ')" } else { "ok" })

$configOk = (
    [string]$config.primaryCampus -eq "lxd" -and
    [string]$config.fallbackCampus -eq "xlh" -and
    [string]$config.browserMode -eq "webbridge" -and
    [string]$config.vpnLaunchMode -eq "explorer_shortcut" -and
    [int]$config.pollIntervalMs -le 100 -and
    [bool]$config.openVpn -and
    [bool]$config.mailOnCompletion -and
    -not [bool]$config.disablePartialFallback -and
    [int]$config.maxBookingMinutes -eq 90 -and
    [int]$config.maxBookingAmount -eq 15 -and
    [int]$config.partialMinMinutes -ge 60
)
Add-Check "config:formal-lxd-first" $configOk "browserMode=$($config.browserMode); primary=$($config.primaryCampus); fallback=$($config.fallbackCampus); poll=$($config.pollIntervalMs); vpnLaunchMode=$($config.vpnLaunchMode); partialDisabled=$($config.disablePartialFallback); maxMinutes=$($config.maxBookingMinutes); maxAmount=$($config.maxBookingAmount); partialMin=$($config.partialMinMinutes)"

Add-Check "file:easyconnect-shortcut" (Test-Path -LiteralPath ([string]$config.easyConnectShortcutPath)) ([string]$config.easyConnectShortcutPath)

$taskPathCandidates = New-Object System.Collections.Generic.List[string]
$taskPathPattern = '(?i)([A-Z]:\\[^"]+\.(?:exe|mjs|ps1|json|lnk))'
foreach ($task in @(Get-ScheduledTask -TaskName "CodexBadminton*" -ErrorAction SilentlyContinue)) {
    foreach ($action in @($task.Actions)) {
        $actionText = "$($action.Execute) $($action.Arguments)"
        foreach ($match in [regex]::Matches($actionText, $taskPathPattern)) {
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

$currentTaskName = [string]$config.taskName
if (-not $currentTaskName) { $currentTaskName = "CodexBadminton_LXD_1900_2100" }
$currentTask = Get-ScheduledTask -TaskName $currentTaskName -ErrorAction SilentlyContinue
if (-not $currentTask) {
    Add-Check "task:current-installed-profile" $false "missing task $currentTaskName"
} else {
    $currentActionText = (($currentTask.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join " ")
    $currentConfigPath = ""
    $quotedConfigMatch = [regex]::Match($currentActionText, '(?:--config|-ConfigPath)\s+"([^"]+)"')
    $plainConfigMatch = [regex]::Match($currentActionText, '(?:--config|-ConfigPath)\s+(\S+)')
    $quotedConfigJsonMatch = [regex]::Match($currentActionText, '-ConfigJsonBase64\s+"([^"]+)"')
    $plainConfigJsonMatch = [regex]::Match($currentActionText, '-ConfigJsonBase64\s+(\S+)')
    if ($quotedConfigMatch.Success) {
        $currentConfigPath = $quotedConfigMatch.Groups[1].Value
    } elseif ($plainConfigMatch.Success) {
        $currentConfigPath = $plainConfigMatch.Groups[1].Value
    } elseif ($quotedConfigJsonMatch.Success -or $plainConfigJsonMatch.Success) {
        $currentConfigJsonBase64 = if ($quotedConfigJsonMatch.Success) { $quotedConfigJsonMatch.Groups[1].Value } else { $plainConfigJsonMatch.Groups[1].Value }
        try {
            $currentConfigJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($currentConfigJsonBase64))
            $currentConfigObject = $currentConfigJson | ConvertFrom-Json
            $tempConfigPath = Join-Path $root "logs\current_installed_task_config.json"
            Write-JsonFile -Value $currentConfigObject -Path $tempConfigPath -Depth 20
            $currentConfigPath = $tempConfigPath
        } catch {
            Add-Check "task:current-installed-profile" $false "invalid -ConfigJsonBase64 in $currentActionText; $($_.Exception.Message)"
        }
    }
    if (-not $currentConfigPath) {
        Add-Check "task:current-installed-profile" $false "missing config argument in $currentActionText"
    } else {
        $assertScript = Join-Path $root "tools\assert-success-profile.ps1"
        $assertOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $assertScript -ConfigPath $currentConfigPath -CheckTasks -FlexibleVariables -Quiet 2>&1
        Add-Check "task:current-installed-profile" ($LASTEXITCODE -eq 0) $(if ($LASTEXITCODE -eq 0) { $currentConfigPath } else { ($assertOutput -join "`n") })
        $smokeScript = Join-Path $root "tools\test-scheduled-wrapper.ps1"
        $smokeOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $smokeScript -SourceTaskName $currentTaskName -Quiet 2>&1
        Add-Check "task:scheduled-wrapper-smoke" ($LASTEXITCODE -eq 0) $(if ($LASTEXITCODE -eq 0) { "Task Scheduler executed wrapper and wrote a success result." } else { ($smokeOutput -join "`n") })
    }
}

$plaintextSecretFieldNames = @("password", "smtpPassword", "smtpAuthorizationCode", "apiKey", "token", "cookie")
$plaintextSecretFields = @($plaintextSecretFieldNames | Where-Object {
    $property = $config.PSObject.Properties[$_]
    $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)
})
Add-Check "secret:no-plaintext-secret-fields" ($plaintextSecretFields.Count -eq 0) $(if ($plaintextSecretFields.Count -eq 0) { "config uses secret file references" } else { "remove fields: $($plaintextSecretFields -join ', ')" })

$jsonFiles = @(
    (Resolve-ProjectPath -Root $root -Path $ConfigPath)
)
$generatedDir = Join-Path $root "config\generated"
if (Test-Path -LiteralPath $generatedDir) {
    $jsonFiles += @(Get-ChildItem -LiteralPath $generatedDir -Filter "*.json" -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
}
$bomFiles = @()
foreach ($jsonFile in @($jsonFiles | Sort-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $jsonFile)) { continue }
    $bytes = [System.IO.File]::ReadAllBytes($jsonFile)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $bomFiles += $jsonFile
    }
}
Add-Check "config:utf8-no-bom" ($bomFiles.Count -eq 0) $(if ($bomFiles.Count) { "BOM files: $($bomFiles -join '; ')" } else { "checked $(@($jsonFiles | Sort-Object -Unique).Count) json files" })

$failed = @($checks | Where-Object { -not $_.ok })
foreach ($check in $checks) {
    "{0} {1} {2}" -f ($(if ($check.ok) { "OK" } else { "FAIL" })), $check.name, $check.detail
}
if ($failed.Count) {
    exit 1
}
