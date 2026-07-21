param(
    [string]$ConfigPath = "config/local.json",
    [string]$RunDate = "",
    [string]$TargetDate = "",
    [string]$PrimaryCampus = "",
    [string]$FallbackCampus = "",
    [string]$DesiredStartTime = "",
    [string]$DesiredEndTime = "",
    [int]$MaxBookingMinutes = 0,
    [decimal]$MaxBookingAmount = 0,
    [int]$PartialMinMinutes = 0,
    [string]$InstallSource = "cli",
    [switch]$NoConfirmPayment,
    [switch]$RunPrecheckNow,
    [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath
$resolvedConfigPath = Resolve-ProjectPath -Root $root -Path $ConfigPath

function Invoke-Checked {
    param([Parameter(Mandatory)][scriptblock]$ScriptBlock, [string]$Name = "command")
    $global:LASTEXITCODE = 0
    & $ScriptBlock
    if (-not $?) {
        throw "$Name failed"
    }
    if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

Invoke-Checked -Name "assert-success-profile" -ScriptBlock {
    & (Join-Path $root "tools\assert-success-profile.ps1") -ConfigPath $resolvedConfigPath -Quiet
}

$effectiveConfig = ConvertTo-Hashtable -Object $config
$hasOverrides = $false
if ($PrimaryCampus) { $effectiveConfig["primaryCampus"] = $PrimaryCampus; $hasOverrides = $true }
if ($FallbackCampus) { $effectiveConfig["fallbackCampus"] = $FallbackCampus; $hasOverrides = $true }
if ($DesiredStartTime) { $effectiveConfig["desiredStartTime"] = $DesiredStartTime; $hasOverrides = $true }
if ($DesiredEndTime) { $effectiveConfig["desiredEndTime"] = $DesiredEndTime; $hasOverrides = $true }
if ($MaxBookingMinutes -gt 0) { $effectiveConfig["maxBookingMinutes"] = $MaxBookingMinutes; $hasOverrides = $true }
if ($MaxBookingAmount -gt 0) { $effectiveConfig["maxBookingAmount"] = $MaxBookingAmount; $hasOverrides = $true }
if ($PartialMinMinutes -gt 0) { $effectiveConfig["partialMinMinutes"] = $PartialMinMinutes; $hasOverrides = $true }

function Convert-TimeToMinutes {
    param([string]$TimeText)
    if ($TimeText -notmatch '^(\d{1,2}):(\d{2})$') { throw "Invalid time format: $TimeText" }
    return ([int]$matches[1] * 60) + [int]$matches[2]
}

function Test-EffectiveConfig {
    param([Parameter(Mandatory)]$ConfigHash)
    $primary = [string]$ConfigHash["primaryCampus"]
    $fallback = [string]$ConfigHash["fallbackCampus"]
    $start = [string]$ConfigHash["desiredStartTime"]
    $end = [string]$ConfigHash["desiredEndTime"]
    $startMinutes = Convert-TimeToMinutes -TimeText $start
    $endMinutes = Convert-TimeToMinutes -TimeText $end
    if ($primary -notin @("lxd", "xlh")) { throw "primaryCampus must be lxd or xlh; got $primary" }
    if ($fallback -notin @("lxd", "xlh", "none", "auto")) { throw "fallbackCampus must be lxd/xlh/none/auto; got $fallback" }
    if ($fallback -eq $primary) { throw "fallbackCampus must differ from primaryCampus; got $primary" }
    if ($startMinutes -lt 480 -or $endMinutes -gt 1320 -or $endMinutes -le $startMinutes) { throw "desired time must be inside 08:00-22:00 and end after start; got $start-$end" }
    if ((($endMinutes - $startMinutes) % 30) -ne 0) { throw "desired time range must align to 30-minute slots; got $start-$end" }
    if ([int]$ConfigHash["maxBookingMinutes"] -lt 60 -or [int]$ConfigHash["maxBookingMinutes"] -gt 120) { throw "maxBookingMinutes must be 60-120" }
    if ([decimal]$ConfigHash["maxBookingAmount"] -le 0) { throw "maxBookingAmount must be positive" }
    if ([int]$ConfigHash["partialMinMinutes"] -lt 60) { throw "partialMinMinutes must be at least 60" }
    if ([string]$ConfigHash["browserMode"] -ne "webbridge") { throw "browserMode must stay webbridge" }
    if ([string]$ConfigHash["vpnLaunchMode"] -ne "explorer_shortcut") { throw "vpnLaunchMode must stay explorer_shortcut" }
    if (-not [bool]$ConfigHash["openVpn"]) { throw "openVpn must stay true" }
    if (-not [bool]$ConfigHash["mailOnCompletion"]) { throw "mailOnCompletion must stay true" }
}

Test-EffectiveConfig -ConfigHash $effectiveConfig

$now = Get-Date
if ([string]::IsNullOrWhiteSpace($RunDate)) {
    $todayStart = Get-TimeOnDate -Date $now.Date -TimeText ([string]$config.taskStartTime)
    if ($now -lt $todayStart.AddMinutes(-1)) {
        $runDateValue = $now.Date
    } else {
        $runDateValue = $now.Date.AddDays(1)
    }
} else {
    $runDateValue = Get-DateOnly -Value $RunDate -Default $now.Date
}

if ([string]::IsNullOrWhiteSpace($TargetDate)) {
    $targetDateValue = $runDateValue.AddDays(1)
} else {
    $targetDateValue = Get-DateOnly -Value $TargetDate -Default $runDateValue.AddDays(1)
}

$runKey = New-RunKey -RunDate $runDateValue -TargetDate $targetDateValue -Config $config
$effectiveConfigObject = [pscustomobject]$effectiveConfig
$runKey = New-RunKey -RunDate $runDateValue -TargetDate $targetDateValue -Config $effectiveConfigObject
$taskName = [string]$config.taskName
if (-not $taskName) { $taskName = "CodexBadminton_LXD_1900_2100" }

$installConfigPath = $resolvedConfigPath
if ($hasOverrides) {
    $generatedDir = Join-Path $root "config\generated"
    $installConfigPath = Join-Path $generatedDir ("formal_{0}_for_{1}.json" -f $runDateValue.ToString("yyyyMMdd"), $targetDateValue.ToString("yyyyMMdd"))
    if (-not $PlanOnly) {
        New-Item -ItemType Directory -Path $generatedDir -Force | Out-Null
        Write-JsonFile -Value $effectiveConfig -Path $installConfigPath -Depth 20
        Invoke-Checked -Name "assert-success-profile generated" -ScriptBlock {
            & (Join-Path $root "tools\assert-success-profile.ps1") -ConfigPath $installConfigPath -FlexibleVariables -Quiet
        }
    }
}

$taskStart = Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.taskStartTime)
$plan = [ordered]@{
    planOnly = [bool]$PlanOnly
    installSource = $InstallSource
    baseConfigPath = $resolvedConfigPath
    configPath = $installConfigPath
    configWritten = ($hasOverrides -and -not [bool]$PlanOnly)
    hasOverrides = $hasOverrides
    taskName = $taskName
    runDate = $runDateValue.ToString("yyyy-MM-dd")
    targetDate = $targetDateValue.ToString("yyyy-MM-dd")
    runKey = $runKey
    bookingStart = $taskStart.ToString("yyyy-MM-dd HH:mm:ss")
    webBridgePrestart = $taskStart.AddMinutes(-25).ToString("yyyy-MM-dd HH:mm:ss")
    vpnPreconnect = $taskStart.AddMinutes(-20).ToString("yyyy-MM-dd HH:mm:ss")
    preflight = $taskStart.AddMinutes(-10).ToString("yyyy-MM-dd HH:mm:ss")
    postcheck = (Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.pollUntilTime)).AddMinutes(5).ToString("yyyy-MM-dd HH:mm:ss")
    primaryCampus = [string]$effectiveConfig["primaryCampus"]
    fallbackCampus = [string]$effectiveConfig["fallbackCampus"]
    desired = "$($effectiveConfig["desiredStartTime"])-$($effectiveConfig["desiredEndTime"])"
    maxBookingMinutes = [int]$effectiveConfig["maxBookingMinutes"]
    maxBookingAmount = [decimal]$effectiveConfig["maxBookingAmount"]
    partialMinMinutes = [int]$effectiveConfig["partialMinMinutes"]
    paymentEnabled = -not [bool]$NoConfirmPayment
    browserMode = [string]$effectiveConfig["browserMode"]
}

if ($PlanOnly) {
    $plan | ConvertTo-Json -Depth 8
    exit 0
}

$installArgs = @{
    ConfigPath = $installConfigPath
    RunDate = $runDateValue.ToString("yyyy-MM-dd")
    TargetDate = $targetDateValue.ToString("yyyy-MM-dd")
}
if ($NoConfirmPayment) {
    $installArgs["NoConfirmPayment"] = $true
}
if (-not $RunPrecheckNow) {
    $installArgs["SkipPrecheckNow"] = $true
}

Invoke-Checked -Name "install-task" -ScriptBlock {
    & (Join-Path $root "tools\install-task.ps1") @installArgs | Out-Host
}

Invoke-Checked -Name "scheduled-wrapper-smoke" -ScriptBlock {
    & (Join-Path $root "tools\test-scheduled-wrapper.ps1") -SourceTaskName $taskName -Quiet
}

Invoke-Checked -Name "scheduled-mail-smoke" -ScriptBlock {
    & (Join-Path $root "tools\test-scheduled-mail.ps1") -SourceTaskName $taskName -Quiet
}

Invoke-Checked -Name "assert-success-profile -CheckTasks" -ScriptBlock {
    & (Join-Path $root "tools\assert-success-profile.ps1") -ConfigPath $installConfigPath -CheckTasks -FlexibleVariables -Quiet
}

$taskRows = @(Get-ScheduledTask -TaskName "${taskName}*" | Sort-Object TaskName | ForEach-Object {
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName
    $actionText = (($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join " ")
    [ordered]@{
        taskName = $_.TaskName
        state = [string]$_.State
        nextRunTime = $(if ($info.NextRunTime) { $info.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" })
        lastRunTime = $(if ($info.LastRunTime) { $info.LastRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" })
        lastTaskResult = [int]$info.LastTaskResult
        action = $actionText
    }
})

$verification = [ordered]@{
    installed = $true
    generatedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss K")
    plan = $plan
    tasks = $taskRows
}

$logPath = Join-Path $root ("logs\schedule_next_formal_{0}_for_{1}.json" -f $runDateValue.ToString("yyyyMMdd"), $targetDateValue.ToString("yyyyMMdd"))
Write-JsonFile -Value $verification -Path $logPath -Depth 12
$verification["verificationLog"] = $logPath
$verification | ConvertTo-Json -Depth 12
