param(
    [string]$ConfigPath = "config/local.json",
    [string]$ConfigJsonBase64 = "",
    [string]$RunDate = "",
    [string]$TargetDate = "",
    [string]$RunKey = "",
    [switch]$DryRun,
    [switch]$NoConfirmPayment,
    [switch]$AllowLateStart,
    [switch]$Preflight,
    [switch]$StartupSmokeTest,
    [string]$Session = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath -ConfigJsonBase64 $ConfigJsonBase64
$runDateValue = Get-DateOnly -Value $RunDate -Default (Get-Date).Date
$targetDateValue = Get-DateOnly -Value $TargetDate -Default $runDateValue.AddDays(1)
if (-not $RunKey) {
    $RunKey = New-RunKey -RunDate $runDateValue -TargetDate $targetDateValue -Config $config
}

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$runPrefix = Resolve-RunPrefix -LogDir $logDir -RunKey $RunKey
$logPath = "$runPrefix.log"
$errPath = "$runPrefix.err.log"
$resultPath = "$runPrefix.result.json"
$mailLogPath = "$runPrefix.mail.log"
$wrapperOutPath = "$runPrefix.wrapper.out.log"
$wrapperErrPath = "$runPrefix.wrapper.err.log"
$runnerConfigPath = if ($ConfigJsonBase64) { "$runPrefix.effective.config.json" } else { Resolve-ProjectPath -Root $root -Path $ConfigPath }
if ($ConfigJsonBase64) {
    Write-JsonFile -Value (ConvertTo-Hashtable -Object $config) -Path $runnerConfigPath -Depth 20
}
$startedAt = Get-Date

$pollUntil = Get-TimeOnDate -Date $runDateValue -TimeText ([string]$config.pollUntilTime)
$now = Get-Date

function Find-FreshRunnerResult {
    $pattern = if ($Preflight) {
        "preflight_$($runDateValue.ToString('yyyyMMdd'))_for_$($targetDateValue.ToString('yyyyMMdd'))_*.result.json"
    } else {
        "$RunKey*.result.json"
    }
    $fresh = @(Get-ChildItem -LiteralPath $logDir -Filter $pattern -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $script:startedAt.AddSeconds(-2) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1)
    if ($fresh) { return $fresh[0] }
    return $null
}

function Complete-Run {
    param(
        [Parameter(Mandatory)][bool]$Success,
        [Parameter(Mandatory)][string]$Message,
        [int]$ExitCode = 0
    )

    $Message | Set-Content -LiteralPath $logPath -Encoding UTF8
    if (-not $Success) {
        $Message | Set-Content -LiteralPath $errPath -Encoding UTF8
    }

    $result = [ordered]@{
        success = $Success
        failureReason = $(if ($Success) { "" } else { $Message })
        runner = $(if ($Preflight) { "webbridge_preflight_wrapper" } else { "webbridge_wrapper" })
        dryRun = [bool]$DryRun
        noConfirmPayment = [bool]$NoConfirmPayment
        preflight = [bool]$Preflight
        startupSmokeTest = [bool]$StartupSmokeTest
        run = [ordered]@{
            runDate = $runDateValue.ToString("yyyy-MM-dd")
            targetDate = $targetDateValue.ToString("yyyy-MM-dd")
            desiredStartTime = [string]$config.desiredStartTime
            desiredEndTime = [string]$config.desiredEndTime
            primaryCampus = [string]$config.primaryCampus
            fallbackCampus = [string]$config.fallbackCampus
            browserMode = [string]$config.browserMode
        }
        logPath = $logPath
        errPath = $(if ($Success) { "" } else { $errPath })
        stdoutPath = $wrapperOutPath
        stderrPath = $wrapperErrPath
        nextAction = "Check wrapper stdout/stderr logs, then rerun tools/install-next-formal-run.ps1 after fixing the startup error."
    }
    Write-JsonFile -Value $result -Path $resultPath

    if ([bool]$config.mailOnCompletion -and -not $StartupSmokeTest) {
        Send-ResultMail -Config $config -ResultPath $resultPath -LogPath $logPath -MailLogPath $mailLogPath -TaskName ([string]$config.taskName)
    }

    Write-Output (Get-Content -LiteralPath $resultPath -Raw)
    exit $ExitCode
}

if ($StartupSmokeTest) {
    Complete-Run -Success $true -Message "Startup smoke test passed: Task Scheduler reached run-booking.ps1, decoded config, resolved project paths, and wrote result/log files." -ExitCode 0
}

if (-not $AllowLateStart -and $now.Date -eq $runDateValue.Date -and $now -gt $pollUntil) {
    Complete-Run -Success $false -Message "Refusing stale run: started at $($now.ToString('yyyy-MM-dd HH:mm:ss')), after pollUntil $($pollUntil.ToString('yyyy-MM-dd HH:mm:ss'))." -ExitCode 2
}
if (-not $AllowLateStart -and $now.Date -gt $runDateValue.Date) {
    Complete-Run -Success $false -Message "Refusing stale run: runDate=$($runDateValue.ToString('yyyy-MM-dd')) is before today $($now.ToString('yyyy-MM-dd'))." -ExitCode 2
}

$logicPath = Join-Path $root "scripts\booking_logic.mjs"
$webBridgeRunnerPath = Join-Path $root "scripts\webbridge_runner.mjs"
$codexPluginRunnerPath = Join-Path $root "scripts\codex_plugin_runner.mjs"
foreach ($required in @($logicPath, $webBridgeRunnerPath)) {
    if (-not (Test-Path -LiteralPath $required)) {
        Complete-Run -Success $false -Message "Required WebBridge runner file missing: $required" -ExitCode 3
    }
}

if ([string]$config.browserMode -eq "webbridge") {
    $node = Get-Command node -ErrorAction Stop
    $sessionValue = if ($Session) {
        $Session
    } elseif ($Preflight) {
        "badminton-preflight-$($runDateValue.ToString('yyyyMMdd'))"
    } else {
        "badminton-manual-$($runDateValue.ToString('yyyyMMdd'))"
    }
    $runnerArgs = @(
        $webBridgeRunnerPath,
        "--config", $runnerConfigPath,
        "--runDate", $runDateValue.ToString("yyyy-MM-dd"),
        "--targetDate", $targetDateValue.ToString("yyyy-MM-dd"),
        "--session", $sessionValue
    )
    if ($DryRun) { $runnerArgs += "--dryRun" }
    if ($NoConfirmPayment) { $runnerArgs += "--noConfirmPayment" }
    if ($Preflight) { $runnerArgs += "--preflight" }

    Remove-Item -LiteralPath $wrapperOutPath, $wrapperErrPath -Force -ErrorAction SilentlyContinue
    try {
        & $node.Source @runnerArgs > $wrapperOutPath 2> $wrapperErrPath
        $nodeExitCode = $LASTEXITCODE
    } catch {
        $nodeExitCode = 1
        $_.Exception.Message | Set-Content -LiteralPath $wrapperErrPath -Encoding UTF8
    }

    $freshResult = Find-FreshRunnerResult
    if ($freshResult) {
        exit $nodeExitCode
    }

    $stdout = if (Test-Path -LiteralPath $wrapperOutPath) { Get-Content -LiteralPath $wrapperOutPath -Raw } else { "" }
    $stderr = if (Test-Path -LiteralPath $wrapperErrPath) { Get-Content -LiteralPath $wrapperErrPath -Raw } else { "" }
    $message = @(
        "WebBridge runner exited before writing a result file.",
        "exitCode=$nodeExitCode",
        "config=$runnerConfigPath",
        "runDate=$($runDateValue.ToString('yyyy-MM-dd')) targetDate=$($targetDateValue.ToString('yyyy-MM-dd')) preflight=$([bool]$Preflight)",
        "stdoutPath=$wrapperOutPath",
        "stderrPath=$wrapperErrPath",
        "stdout: $($stdout.Trim())",
        "stderr: $($stderr.Trim())"
    ) -join "`r`n"
    Complete-Run -Success $false -Message $message -ExitCode $(if ($nodeExitCode -ne 0) { $nodeExitCode } else { 4 })
}

if (-not (Test-Path -LiteralPath $codexPluginRunnerPath)) {
    Complete-Run -Success $false -Message "Required Codex plugin runner file missing: $codexPluginRunnerPath" -ExitCode 3
}

Complete-Run -Success $false -Message "PowerShell local execution is only enabled for browserMode=webbridge. Current browserMode=$($config.browserMode)." -ExitCode 2
