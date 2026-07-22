param(
    [string]$ConfigPath = "config/local.json",
    [string]$ConfigJsonBase64 = "",
    [string]$RunDate = "",
    [string]$TargetDate = "",
    [string]$RunKey = "",
    [string]$FormalTaskName = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath -ConfigJsonBase64 $ConfigJsonBase64
$runDateValue = Get-DateOnly -Value $RunDate -Default (Get-Date).Date
$targetDateValue = Get-DateOnly -Value $TargetDate -Default $runDateValue.AddDays(1)
if (-not $RunKey) { $RunKey = New-RunKey -RunDate $runDateValue -TargetDate $targetDateValue -Config $config }

$logDir = Join-Path $root "logs"
$postcheckLog = Join-Path $logDir "postcheck_$RunKey.log"
$taskStart = Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.taskStartTime)
$latestAnyResult = @(Get-ChildItem -LiteralPath $logDir -Filter "$RunKey*.result.json" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
$result = @($latestAnyResult | Where-Object { $_.LastWriteTime -ge $taskStart.AddMinutes(-2) })

if (-not $result) {
    $syntheticPrefix = Join-Path $logDir "${RunKey}_postcheck_missing"
    $resultPath = "$syntheticPrefix.result.json"
    $errPath = "$syntheticPrefix.err.log"
    $reason = "Postcheck: no fresh result file found for RunKey=$RunKey after taskStart=$($taskStart.ToString('yyyy-MM-dd HH:mm:ss'))."
    if ($latestAnyResult) {
        $reason += " Latest matching result was $($latestAnyResult.FullName), LastWriteTime=$($latestAnyResult.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))."
    }
    $taskDetail = ""
    if ($FormalTaskName) {
        try {
            $task = Get-ScheduledTask -TaskName $FormalTaskName -ErrorAction Stop
            $info = Get-ScheduledTaskInfo -TaskName $FormalTaskName -ErrorAction Stop
            $taskDetail = " Task state=$($task.State); lastRun=$($info.LastRunTime); code=$($info.LastTaskResult)."
        } catch {
            $taskDetail = " Task info error: $($_.Exception.Message)"
        }
    }
    $reason = $reason + $taskDetail
    $reason | Set-Content -LiteralPath $postcheckLog -Encoding UTF8
    $reason | Set-Content -LiteralPath $errPath -Encoding UTF8
    $value = New-SyntheticResult -Success $false -FailureReason $reason -Config $config -RunDate $runDateValue -TargetDate $targetDateValue -LogPath $postcheckLog -ErrPath $errPath
    Write-JsonFile -Value $value -Path $resultPath
    Send-ResultMail -Config $config -ResultPath $resultPath -LogPath $postcheckLog -MailLogPath "$syntheticPrefix.mail.log" -TaskName ([string]$config.taskName)
    exit 2
}

$lines = @(
    "Badminton Booking Assistant postcheck",
    "RunKey: $RunKey",
    "Result: $($result.FullName)",
    "ResultWrite: $($result.LastWriteTime)",
    "TaskStart: $taskStart"
)
if ($result.LastWriteTime -lt $taskStart.AddMinutes(-2)) {
    $lines += "Status: STALE_RESULT"
} else {
    $raw = Get-Content -LiteralPath $result.FullName -Raw
    $json = $raw | ConvertFrom-Json
    $lines += "Status: $(if ([bool]$json.success) { 'SUCCESS' } else { 'FAILURE' })"
    $lines += "FailureReason: $($json.failureReason)"
}

$resultPrefix = $result.FullName -replace "\.result\.json$", ""
$mailLog = "$resultPrefix.mail.log"
$mailOk = $false
if (Test-Path -LiteralPath $mailLog) {
    try {
        $mailJson = Get-Content -LiteralPath $mailLog -Raw | ConvertFrom-Json
        $mailOk = [bool]$mailJson.success
    } catch {
        $lines += "MailLogParseError: $($_.Exception.Message)"
    }
}
if (-not $mailOk) {
    $lines += "MailStatus: missing_or_failed; retrying send"
    Send-ResultMail -Config $config -ResultPath $result.FullName -LogPath ($resultPrefix + ".log") -MailLogPath $mailLog -TaskName ([string]$config.taskName)
} else {
    $lines += "MailStatus: OK"
}

$lines | Set-Content -LiteralPath $postcheckLog -Encoding UTF8
Get-Content -LiteralPath $postcheckLog
