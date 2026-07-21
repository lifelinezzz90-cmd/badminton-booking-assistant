param(
    [string]$ConfigPath = "config/local.json",
    [string]$SourceTaskName = "",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$runKey = "scheduled_wrapper_smoke_$stamp"
$taskName = "CodexBadminton_Smoke_$stamp"
$runDateValue = (Get-Date).Date
$targetDateValue = $runDateValue.AddDays(1)
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
    $configHash = ConvertTo-Hashtable -Object $config
    $configJson = $configHash | ConvertTo-Json -Depth 20
    $configJsonBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($configJson))
}

$script = Join-Path $root "tools\run-booking.ps1"
$args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$script`"",
    "-ConfigJsonBase64", "`"$configJsonBase64`"",
    "-RunDate", $runDateValue.ToString("yyyy-MM-dd"),
    "-TargetDate", $targetDateValue.ToString("yyyy-MM-dd"),
    "-RunKey", $runKey,
    "-Session", $runKey,
    "-StartupSmokeTest"
)

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($args -join " ") -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal

try {
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    $started = Get-Date
    Start-ScheduledTask -TaskName $taskName

    $info = $null
    $state = ""
    $resultFile = $null
    $deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 500
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
        $resultFile = @(Get-ChildItem -LiteralPath (Join-Path $root "logs") -Filter "$runKey*.result.json" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1)
        $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State
    } while ((Get-Date) -lt $deadline -and (-not $resultFile -or $state -eq "Running" -or [int]$info.LastTaskResult -eq 267009))

    if (-not $resultFile) {
        throw "Scheduled wrapper smoke did not write a result file. taskResult=$($info.LastTaskResult)"
    }

    for ($i = 0; $i -lt 10 -and [int]$info.LastTaskResult -eq 267009; $i++) {
        Start-Sleep -Milliseconds 500
        $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction Stop
        $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State
    }

    $jsonText = [System.IO.File]::ReadAllText($resultFile.FullName, [System.Text.Encoding]::UTF8).TrimStart([char]0xfeff)
    $result = $jsonText | ConvertFrom-Json
    $schedulerStillRefreshing = ([int]$info.LastTaskResult -eq 267009 -and [string]$state -ne "Running")
    $ok = (([int]$info.LastTaskResult -eq 0 -or $schedulerStillRefreshing) -and [bool]$result.success -and [bool]$result.startupSmokeTest)
    $summary = [pscustomobject]@{
        ok = $ok
        taskName = $taskName
        taskState = [string]$state
        lastTaskResult = [int]$info.LastTaskResult
        schedulerStillRefreshing = [bool]$schedulerStillRefreshing
        runKey = $runKey
        resultPath = $resultFile.FullName
        success = [bool]$result.success
        startupSmokeTest = [bool]$result.startupSmokeTest
        message = [string]$result.failureReason
    }
    if (-not $Quiet) {
        $summary | ConvertTo-Json -Depth 5
    }
    if (-not $ok) {
        throw "Scheduled wrapper smoke failed: $($summary | ConvertTo-Json -Compress -Depth 5)"
    }
} finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
