param(
    [string]$ConfigPath = "config/local.json",
    [string]$ConfigJsonBase64 = "",
    [string]$RunKey = "",
    [string]$Subject = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$config = Read-BookingConfig -ConfigPath $ConfigPath -ConfigJsonBase64 $ConfigJsonBase64
if (-not $RunKey) {
    $RunKey = "scheduled_mail_smoke_{0}" -f (Get-Date -Format "yyyyMMdd_HHmmss")
}
if (-not $Subject) {
    $Subject = "Badminton scheduled mail smoke {0}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
}

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$prefix = Join-Path $logDir $RunKey
$bodyPath = "$prefix.body.txt"
$resultPath = "$prefix.result.json"
$mailLogPath = "$prefix.mail.log"
$smtpSecret = Resolve-ProjectPath -Root $root -Path ([string]$config.smtpSecret)

$body = @(
    "This is an automatic mail smoke test triggered by Windows Task Scheduler.",
    "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')",
    "Project: $root",
    "RunKey: $RunKey",
    "Receiving this mail proves the scheduled-task environment can send mail without a manual resend from chat."
) -join "`r`n"
$body | Set-Content -LiteralPath $bodyPath -Encoding UTF8

try {
    $output = & (Join-Path $root "scripts\send_status_email.ps1") `
        -Subject $Subject `
        -BodyPath $bodyPath `
        -To ([string]$config.mailTo) `
        -From ([string]$config.mailFrom) `
        -SmtpServer ([string]$config.smtpServer) `
        -SmtpPort ([int]$config.smtpPort) `
        -CredentialSecureStringPath $smtpSecret 2>&1
    $output | Set-Content -LiteralPath $mailLogPath -Encoding UTF8
    $mailJson = ($output -join "`n") | ConvertFrom-Json
    $result = [ordered]@{
        success = $true
        runKey = $RunKey
        subject = $Subject
        to = [string]$mailJson.to
        from = [string]$mailJson.from
        bodyPath = $bodyPath
        mailLogPath = $mailLogPath
        triggeredBy = "windows-scheduled-task"
    }
    Write-JsonFile -Value $result -Path $resultPath
    Get-Content -LiteralPath $resultPath -Raw
    exit 0
} catch {
    $message = $_.Exception.Message
    $message | Set-Content -LiteralPath $mailLogPath -Encoding UTF8
    $result = [ordered]@{
        success = $false
        runKey = $RunKey
        subject = $Subject
        to = [string]$config.mailTo
        bodyPath = $bodyPath
        mailLogPath = $mailLogPath
        failureReason = $message
        triggeredBy = "windows-scheduled-task"
    }
    Write-JsonFile -Value $result -Path $resultPath
    Get-Content -LiteralPath $resultPath -Raw
    exit 1
}
