param(
    [string]$ConfigPath = "config/local.json",
    [string]$SourceTaskName = "",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$runKey = "scheduled_mail_smoke_$stamp"
$taskName = "BadmintonBookingAssistant_MailSmoke_$stamp"
$configJsonBase64 = ""

function Get-EmbeddedConfigFromTask {
    param([Parameter(Mandatory)][string]$Name)
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    $actionText = (($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join " ")
    $quoted = [regex]::Match($actionText, '-ConfigJsonBase64\s+"([^"]+)"')
    $plain = [regex]::Match($actionText, '-ConfigJsonBase64\s+(\S+)')
    if ($quoted.Success) { return $quoted.Groups[1].Value }
    if ($plain.Success) { return $plain.Groups[1].Value }
    return ""
}

if ($SourceTaskName) {
    $configJsonBase64 = Get-EmbeddedConfigFromTask -Name $SourceTaskName
}
if (-not $configJsonBase64) {
    $config = Read-BookingConfig -ConfigPath $ConfigPath
    $configJson = (ConvertTo-Hashtable -Object $config) | ConvertTo-Json -Depth 20
    $configJsonBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($configJson))
}

$script = Join-Path $root "tools\run-mail-smoke.ps1"
$subject = "Badminton scheduled mail smoke $stamp"
$args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$script`"",
    "-ConfigJsonBase64", "`"$configJsonBase64`"",
    "-RunKey", $runKey,
    "-Subject", "`"$subject`""
)

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($args -join " ") -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal

try {
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName

    $resultFile = $null
    $info = $null
    $state = ""
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 500
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
        $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State
        $resultFile = @(Get-ChildItem -LiteralPath (Join-Path $root "logs") -Filter "$runKey.result.json" -File -ErrorAction SilentlyContinue |
            Select-Object -First 1)
    } while ((Get-Date) -lt $deadline -and (-not $resultFile -or $state -eq "Running" -or [int]$info.LastTaskResult -eq 267009))

    if (-not $resultFile) {
        throw "Scheduled mail smoke did not write a result file. taskResult=$($info.LastTaskResult)"
    }
    for ($i = 0; $i -lt 10 -and [int]$info.LastTaskResult -eq 267009; $i++) {
        Start-Sleep -Milliseconds 500
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
        $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State
    }
    $jsonText = [System.IO.File]::ReadAllText($resultFile.FullName, [System.Text.Encoding]::UTF8).TrimStart([char]0xfeff)
    $result = $jsonText | ConvertFrom-Json
    $ok = ([int]$info.LastTaskResult -eq 0 -and [bool]$result.success -and [string]$result.triggeredBy -eq "windows-scheduled-task")
    $summary = [pscustomobject]@{
        ok = $ok
        taskName = $taskName
        taskState = [string]$state
        lastTaskResult = [int]$info.LastTaskResult
        resultPath = $resultFile.FullName
        mailLogPath = [string]$result.mailLogPath
        subject = [string]$result.subject
        to = [string]$result.to
        success = [bool]$result.success
        triggeredBy = [string]$result.triggeredBy
        failureReason = [string]$result.failureReason
    }
    if (-not $Quiet) {
        $summary | ConvertTo-Json -Depth 5
    }
    if (-not $ok) {
        throw "Scheduled mail smoke failed: $($summary | ConvertTo-Json -Compress -Depth 5)"
    }
} finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
