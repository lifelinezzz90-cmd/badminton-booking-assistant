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
$overrides = @{}
if ($PrimaryCampus) { $overrides["primaryCampus"] = $PrimaryCampus }
if ($FallbackCampus) { $overrides["fallbackCampus"] = $FallbackCampus }
if ($DesiredStartTime) { $overrides["desiredStartTime"] = $DesiredStartTime }
if ($DesiredEndTime) { $overrides["desiredEndTime"] = $DesiredEndTime }
if ($MaxBookingMinutes -gt 0) { $overrides["maxBookingMinutes"] = $MaxBookingMinutes }
if ($MaxBookingAmount -gt 0) { $overrides["maxBookingAmount"] = $MaxBookingAmount }
if ($PartialMinMinutes -gt 0) { $overrides["partialMinMinutes"] = $PartialMinMinutes }
$config = Read-BookingConfig -ConfigPath $ConfigPath -Overrides $overrides

function Convert-TimeToMinutes {
    param([string]$TimeText)
    if ($TimeText -notmatch '^(\d{2}):(\d{2})$') { throw "Invalid time format: $TimeText" }
    return ([int]$matches[1] * 60) + [int]$matches[2]
}

$primary = [string]$config.primaryCampus
$fallback = [string]$config.fallbackCampus
$startMinutes = Convert-TimeToMinutes -TimeText ([string]$config.desiredStartTime)
$endMinutes = Convert-TimeToMinutes -TimeText ([string]$config.desiredEndTime)
if ($primary -notin @("lxd", "xlh")) { throw "primaryCampus must be lxd or xlh" }
if ($fallback -notin @("lxd", "xlh", "none", "auto")) { throw "fallbackCampus must be lxd, xlh, auto, or none" }
if ($fallback -eq $primary) { throw "fallbackCampus must differ from primaryCampus" }
if ($startMinutes -lt 480 -or $endMinutes -gt 1320 -or $endMinutes -le $startMinutes -or (($endMinutes - $startMinutes) % 30) -ne 0) {
    throw "Booking time must be within 08:00-22:00 and aligned to 30-minute slots"
}
if ([int]$config.maxBookingMinutes -lt 60 -or [int]$config.maxBookingMinutes -gt 120) { throw "maxBookingMinutes must be 60-120" }
if ([decimal]$config.maxBookingAmount -le 0) { throw "maxBookingAmount must be positive" }
if ([int]$config.partialMinMinutes -lt 60) { throw "partialMinMinutes must be at least 60" }

$now = Get-Date
if ($TargetDate) {
    $targetDateValue = Get-DateOnly -Value $TargetDate -Default $now.Date.AddDays(2)
} elseif ($RunDate) {
    $runDateCandidate = Get-DateOnly -Value $RunDate -Default $now.Date.AddDays(1)
    $targetDateValue = $runDateCandidate.AddDays(1)
} else {
    $targetDateValue = $now.Date.AddDays(2)
}
$runDateValue = if ($RunDate) { Get-DateOnly -Value $RunDate -Default $targetDateValue.AddDays(-1) } else { $targetDateValue.AddDays(-1) }
if ($runDateValue.Date -ne $targetDateValue.Date.AddDays(-1)) {
    throw "runDate must be exactly one day before targetDate for the supported booking system"
}

$runKey = New-RunKey -RunDate $runDateValue -TargetDate $targetDateValue -Config $config
$taskName = [string]$config.taskName
$taskStart = Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.taskStartTime)
$paymentEnabled = [bool]$config.paymentAutoConfirm -and -not [bool]$NoConfirmPayment

$plan = [ordered]@{
    planOnly = [bool]$PlanOnly
    installSource = $InstallSource
    configPath = (Resolve-ProjectPath -Root $root -Path $ConfigPath)
    taskName = $taskName
    runDate = $runDateValue.ToString("yyyy-MM-dd")
    targetDate = $targetDateValue.ToString("yyyy-MM-dd")
    runKey = $runKey
    primaryCampus = $primary
    fallbackCampus = $fallback
    courtPriority = [ordered]@{
        lxd = [string]$config.lxdCourtPriority
        xlh = [string]$config.xlhCourtPriority
    }
    desired = "$($config.desiredStartTime)-$($config.desiredEndTime)"
    partialFallbackEnabled = -not [bool]$config.disablePartialFallback
    partialMinMinutes = [int]$config.partialMinMinutes
    paymentEnabled = $paymentEnabled
    mailEnabled = [bool]$config.mailOnCompletion
    tasks = @(
        [ordered]@{ role = "webbridge-prestart"; startAt = $taskStart.AddMinutes(-25).ToString("yyyy-MM-dd HH:mm:ss") },
        [ordered]@{ role = "vpn-preconnect"; startAt = $taskStart.AddMinutes(-20).ToString("yyyy-MM-dd HH:mm:ss") },
        [ordered]@{ role = "preflight"; startAt = $taskStart.AddMinutes(-10).ToString("yyyy-MM-dd HH:mm:ss") },
        [ordered]@{ role = "booking"; startAt = $taskStart.ToString("yyyy-MM-dd HH:mm:ss") },
        [ordered]@{ role = "postcheck"; startAt = (Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.pollUntilTime)).AddMinutes(5).ToString("yyyy-MM-dd HH:mm:ss") }
    )
}

if ($PlanOnly) {
    $plan | ConvertTo-Json -Depth 10
    exit 0
}

$generatedDir = Join-Path $root "config\generated"
$generatedPath = Join-Path $generatedDir ("effective_{0}_for_{1}.json" -f $runDateValue.ToString("yyyyMMdd"), $targetDateValue.ToString("yyyyMMdd"))
Write-JsonFile -Value (ConvertTo-Hashtable -Object $config) -Path $generatedPath -Depth 20

$installArgs = @{
    ConfigPath = $generatedPath
    RunDate = $runDateValue.ToString("yyyy-MM-dd")
    TargetDate = $targetDateValue.ToString("yyyy-MM-dd")
}
if (-not $paymentEnabled) { $installArgs["NoConfirmPayment"] = $true }
if (-not $RunPrecheckNow) { $installArgs["SkipPrecheckNow"] = $true }

& (Join-Path $root "tools\install-task.ps1") @installArgs | Out-Host
if ($LASTEXITCODE -ne 0) { throw "install-task.ps1 failed with exit code $LASTEXITCODE" }

& (Join-Path $root "tools\test-scheduled-wrapper.ps1") -SourceTaskName $taskName -Quiet
if ($LASTEXITCODE -ne 0) { throw "scheduled wrapper smoke test failed" }
if ([bool]$config.mailOnCompletion) {
    & (Join-Path $root "tools\test-scheduled-mail.ps1") -SourceTaskName $taskName -Quiet
    if ($LASTEXITCODE -ne 0) { throw "scheduled mail smoke test failed" }
}

$taskRows = @(Get-ScheduledTask -TaskName ($taskName + "*") -ErrorAction Stop | Sort-Object TaskName | ForEach-Object {
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath
    [ordered]@{
        taskName = $_.TaskName
        state = [string]$_.State
        nextRunTime = $(if ($info.NextRunTime) { $info.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" })
        lastRunTime = $(if ($info.LastRunTime) { $info.LastRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" })
        lastTaskResult = [int]$info.LastTaskResult
    }
})
if ($taskRows.Count -ne 5) { throw "Expected 5 project tasks, found $($taskRows.Count)" }

$verification = [ordered]@{
    installed = $true
    generatedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss K")
    effectiveConfigPath = $generatedPath
    plan = $plan
    tasks = $taskRows
}
$logDir = Join-Path $root "logs"
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir ("schedule_{0}_for_{1}.json" -f $runDateValue.ToString("yyyyMMdd"), $targetDateValue.ToString("yyyyMMdd"))
Write-JsonFile -Value $verification -Path $logPath -Depth 12
$verification["verificationLog"] = $logPath
$verification | ConvertTo-Json -Depth 12
