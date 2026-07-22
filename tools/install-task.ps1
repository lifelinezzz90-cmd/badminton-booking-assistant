param(
    [string]$ConfigPath = "config/local.json",
    [string]$RunDate = "",
    [string]$TargetDate = "",
    [switch]$KeepExistingCodexTasks,
    [switch]$SkipPrecheckNow,
    [switch]$SkipSupportTasks,
    [switch]$NoConfirmPayment,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath
if (-not [bool]$config.paymentAutoConfirm) { $NoConfirmPayment = $true }
if ([bool]$config.openVpn -and (-not [string]$config.easyConnectShortcutPath -or -not (Test-Path -LiteralPath ([string]$config.easyConnectShortcutPath)))) {
    throw "EasyConnect shortcut was not discovered. Run .\badminton.ps1 doctor, then set -VpnShortcutPath if needed."
}
if ([string]$config.browserMode -eq "codex_plugin") {
    throw "install-task.ps1 is disabled for browserMode=codex_plugin. Do not install the old WebBridge Windows scheduled task for this production path; run scripts/codex_plugin_runner.mjs from a Codex automation/thread with Chrome plugin and Computer Use available."
}
$runDateValue = Get-DateOnly -Value $RunDate -Default (Get-Date).Date.AddDays(1)
$targetDateValue = Get-DateOnly -Value $TargetDate -Default $runDateValue.AddDays(1)
$runKey = New-RunKey -RunDate $runDateValue -TargetDate $targetDateValue -Config $config

$webBridgeRunner = Join-Path $root "scripts\webbridge_runner.mjs"
$requiredFiles = @(
    (Join-Path $root "scripts\booking_logic.mjs"),
    (Join-Path $root "scripts\config_resolver.mjs"),
    $webBridgeRunner,
    (Join-Path $root "scripts\send_booking_result_email.ps1"),
    (Join-Path $root "tools\common.ps1"),
    (Join-Path $root "tools\open-vpn.ps1"),
    (Join-Path $root "tools\start-webbridge.ps1"),
    (Join-Path $root "tools\click-wechat-allow.ps1"),
    (Join-Path $root "tools\precheck.ps1"),
    (Join-Path $root "tools\postcheck.ps1"),
    (Join-Path $root "tools\install-task.ps1")
)

foreach ($script in @($requiredFiles | Where-Object { $_ -like "*.ps1" })) {
    Test-PowerShellSyntax -Path $script
}
foreach ($script in @($requiredFiles | Where-Object { $_ -like "*.mjs" })) {
    & node --check $script | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "node --check failed: $script"
    }
}

foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $file)) {
        throw "Required file missing: $file"
    }
}

if (-not $SkipPrecheckNow) {
    & (Join-Path $root "tools\precheck.ps1") `
        -ConfigPath (Resolve-ProjectPath -Root $root -Path $ConfigPath) `
        -RunDate $runDateValue.ToString("yyyy-MM-dd") `
        -TargetDate $targetDateValue.ToString("yyyy-MM-dd") `
        -RunKey $runKey
}

if (-not $KeepExistingCodexTasks) {
    $projectPrefix = Get-ProjectTaskPrefix
    $oldTasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like "$projectPrefix*" })
    foreach ($task in $oldTasks) {
        Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false -ErrorAction SilentlyContinue
    }
}

$nodeCommand = Get-Command node -ErrorAction Stop
$nodePath = $nodeCommand.Source
$runBookingScript = Join-Path $root "tools\run-booking.ps1"
$taskConfigHash = ConvertTo-Hashtable -Object $config
$taskConfigJson = $taskConfigHash | ConvertTo-Json -Depth 20
$taskConfigJsonBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($taskConfigJson))
$taskName = [string]$config.taskName
if (-not $taskName) {
    $taskName = "BadmintonBookingAssistant_LXD_1930_2100"
}
if ($taskName -notlike "BadmintonBookingAssistant_*") {
    throw "Refusing to register a task outside the BadmintonBookingAssistant_ namespace: $taskName"
}

$taskStart = Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.taskStartTime)
$webBridgePrestartStart = $taskStart.AddMinutes(-25)
$vpnPreconnectStart = $taskStart.AddMinutes(-20)
$preflightStart = $taskStart.AddMinutes(-10)
$postcheckStart = (Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.pollUntilTime)).AddMinutes(5)
$session = "badminton-scheduled-$($runDateValue.ToString('yyyyMMdd'))"
$runnerArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$runBookingScript`"",
    "-ConfigJsonBase64", "`"$taskConfigJsonBase64`"",
    "-RunDate", $runDateValue.ToString("yyyy-MM-dd"),
    "-TargetDate", $targetDateValue.ToString("yyyy-MM-dd"),
    "-RunKey", $runKey,
    "-Session", $session
)
if ($NoConfirmPayment) { $runnerArgs += "-NoConfirmPayment" }
if ($DryRun) { $runnerArgs += "-DryRun" }

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument ($runnerArgs -join " ") `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At $taskStart
$settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal

Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

$registeredTasks = New-Object System.Collections.Generic.List[object]
$registeredTasks.Add([ordered]@{
    role = "booking"
    taskName = $taskName
    startAt = $taskStart.ToString("yyyy-MM-dd HH:mm:ss")
}) | Out-Null

if (-not $SkipSupportTasks) {
    $webBridgePrestartTaskName = "${taskName}_WebBridgePrestart"
    $webBridgeStartScript = Join-Path $root "tools\start-webbridge.ps1"
    $webBridgeArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$webBridgeStartScript`"",
        "-WaitSeconds", "45",
        "-ExecutablePath", "`"$([string]$config.webBridgeExecutablePath)`"",
        "-ExtensionId", "`"$([string]$config.webBridgeExtensionId)`""
    )
    $webBridgePrestartAction = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument ($webBridgeArgs -join " ") `
        -WorkingDirectory $root
    $webBridgePrestartTrigger = New-ScheduledTaskTrigger -Once -At $webBridgePrestartStart
    $webBridgePrestartTask = New-ScheduledTask -Action $webBridgePrestartAction -Trigger $webBridgePrestartTrigger -Settings $settings -Principal $principal
    Register-ScheduledTask -TaskName $webBridgePrestartTaskName -InputObject $webBridgePrestartTask -Force | Out-Null
    $registeredTasks.Add([ordered]@{
        role = "webbridge-prestart"
        taskName = $webBridgePrestartTaskName
        startAt = $webBridgePrestartStart.ToString("yyyy-MM-dd HH:mm:ss")
    }) | Out-Null

    $vpnPreconnectTaskName = "${taskName}_VpnPreconnect"
    $vpnScript = Join-Path $root "tools\open-vpn.ps1"
    $vpnArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$vpnScript`"",
        "-ShortcutPath", "`"$([string]$config.easyConnectShortcutPath)`"",
        "-WaitSeconds", "180"
    )
    $vpnPreconnectAction = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument ($vpnArgs -join " ") `
        -WorkingDirectory $root
    $vpnPreconnectTrigger = New-ScheduledTaskTrigger -Once -At $vpnPreconnectStart
    $vpnPreconnectTask = New-ScheduledTask -Action $vpnPreconnectAction -Trigger $vpnPreconnectTrigger -Settings $settings -Principal $principal
    Register-ScheduledTask -TaskName $vpnPreconnectTaskName -InputObject $vpnPreconnectTask -Force | Out-Null
    $registeredTasks.Add([ordered]@{
        role = "vpn-preconnect"
        taskName = $vpnPreconnectTaskName
        startAt = $vpnPreconnectStart.ToString("yyyy-MM-dd HH:mm:ss")
    }) | Out-Null

    $preflightTaskName = "${taskName}_Preflight"
    $preflightArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$runBookingScript`"",
        "-ConfigJsonBase64", "`"$taskConfigJsonBase64`"",
        "-RunDate", $runDateValue.ToString("yyyy-MM-dd"),
        "-TargetDate", $targetDateValue.ToString("yyyy-MM-dd"),
        "-RunKey", $runKey,
        "-Session", "${session}-preflight",
        "-Preflight"
    )
    $preflightAction = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument ($preflightArgs -join " ") `
        -WorkingDirectory $root
    $preflightTrigger = New-ScheduledTaskTrigger -Once -At $preflightStart
    $preflightTask = New-ScheduledTask -Action $preflightAction -Trigger $preflightTrigger -Settings $settings -Principal $principal
    Register-ScheduledTask -TaskName $preflightTaskName -InputObject $preflightTask -Force | Out-Null
    $registeredTasks.Add([ordered]@{
        role = "preflight"
        taskName = $preflightTaskName
        startAt = $preflightStart.ToString("yyyy-MM-dd HH:mm:ss")
    }) | Out-Null

    $postcheckTaskName = "${taskName}_Postcheck"
    $postcheckScript = Join-Path $root "tools\postcheck.ps1"
    $postcheckArgs = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$postcheckScript`"",
        "-ConfigJsonBase64", "`"$taskConfigJsonBase64`"",
        "-RunDate", $runDateValue.ToString("yyyy-MM-dd"),
        "-TargetDate", $targetDateValue.ToString("yyyy-MM-dd"),
        "-RunKey", $runKey,
        "-FormalTaskName", $taskName
    )
    $postcheckAction = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument ($postcheckArgs -join " ") `
        -WorkingDirectory $root
    $postcheckTrigger = New-ScheduledTaskTrigger -Once -At $postcheckStart
    $postcheckTask = New-ScheduledTask -Action $postcheckAction -Trigger $postcheckTrigger -Settings $settings -Principal $principal
    Register-ScheduledTask -TaskName $postcheckTaskName -InputObject $postcheckTask -Force | Out-Null
    $registeredTasks.Add([ordered]@{
        role = "postcheck"
        taskName = $postcheckTaskName
        startAt = $postcheckStart.ToString("yyyy-MM-dd HH:mm:ss")
    }) | Out-Null
}

$info = Get-ScheduledTaskInfo -TaskName $taskName
$registered = Get-ScheduledTask -TaskName $taskName
$registeredAction = @($registered.Actions)[0]

[ordered]@{
    installed = $true
    taskName = $taskName
    runDate = $runDateValue.ToString("yyyy-MM-dd")
    targetDate = $targetDateValue.ToString("yyyy-MM-dd")
    startAt = $taskStart.ToString("yyyy-MM-dd HH:mm:ss")
    node = $nodePath
    runner = $webBridgeRunner
    session = $session
    runKey = $runKey
    primaryCampus = [string]$config.primaryCampus
    fallbackCampus = [string]$config.fallbackCampus
    action = ([string]$registeredAction.Execute) + " " + ([string]$registeredAction.Arguments)
    tasks = @($registeredTasks.ToArray())
    nextRunTime = $(if ($info.NextRunTime) { $info.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" })
    lastTaskResult = [int]$info.LastTaskResult
    note = "Windows Task Scheduler runs WebBridge for unattended booking, plus preflight and postcheck support tasks unless skipped. Codex Chrome plugin is reserved for interactive rescue."
} | ConvertTo-Json -Depth 6
