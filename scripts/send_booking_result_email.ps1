param(
    [Parameter(Mandatory)]
    [string]$ResultPath,
    [string]$LogPath = "",
    [Parameter(Mandatory)]
    [string]$To,
    [Parameter(Mandatory)]
    [string]$From,
    [string]$SmtpServer = "smtp.gmail.com",
    [int]$SmtpPort = 587,
    [Parameter(Mandatory)]
    [string]$CredentialSecureStringPath,
    [string]$TaskName = "",
    [string]$SubjectPrefix = ""
)

$ErrorActionPreference = "Stop"
try {
    $script:Utf8NoBomEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = $script:Utf8NoBomEncoding
    [Console]::OutputEncoding = $script:Utf8NoBomEncoding
} catch {
}

function U {
    param([Parameter(Mandatory)][int[]]$CodePoints)
    return -join ($CodePoints | ForEach-Object { [char]$_ })
}

function Repair-Mojibake {
    param([AllowNull()][string]$Text)
    if (-not $Text) { return "" }
    try {
        $bytes = [System.Text.Encoding]::GetEncoding(1252).GetBytes($Text)
        $fixed = [System.Text.Encoding]::UTF8.GetString($bytes)
        if ($fixed -match "[\u4e00-\u9fff]") {
            return $fixed
        }
    } catch {
    }
    return $Text
}

function Get-ValueOrEmpty {
    param($Value)
    if ($null -eq $Value) { return "" }
    return [string]$Value
}

function Read-ResultJson {
    param([Parameter(Mandatory)][string]$Path)
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8).TrimStart([char]0xfeff)
    try {
        return ($raw | ConvertFrom-Json)
    } catch {
        $parseError = $_.Exception.Message
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) {
            throw "Result JSON parse failed and node fallback is unavailable: $parseError"
        }
        $nodeScript = @'
const fs = require("fs");
function clean(value) {
  if (typeof value === "string") {
    return value.replace(/\\/g, "/").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
  }
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clean(item);
    return out;
  }
  return value;
}
const text = fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "");
process.stdout.write(JSON.stringify(clean(JSON.parse(text))));
'@
        $tempScript = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "codex_booking_mail_json_clean_$([guid]::NewGuid().ToString('N')).cjs")
        try {
            [System.IO.File]::WriteAllText($tempScript, $nodeScript, [System.Text.UTF8Encoding]::new($false))
            $normalized = & $node.Source $tempScript $Path
            if ($LASTEXITCODE -ne 0 -or -not $normalized) {
                throw "node fallback returned exit code $LASTEXITCODE"
            }
        } catch {
            throw "Result JSON parse failed and node fallback failed: $parseError; $($_.Exception.Message)"
        } finally {
            Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
        }
        return (($normalized -join "`n") | ConvertFrom-Json)
    }
}

$Text = @{
    SubjectPrefix = U 0x7FBD,0x6BDB,0x7403,0x62A2,0x573A,0x7ED3,0x679C
    Xilihu = U 0x897F,0x4E3D,0x6E56,0x6821,0x533A
    Liuxiandong = U 0x7559,0x4ED9,0x6D1E,0x6821,0x533A
    Unknown = U 0x672A,0x786E,0x5B9A
    Success = U 0x6210,0x529F
    Failure = U 0x5931,0x8D25
    Yes = U 0x662F
    No = U 0x5426
    None = U 0x65E0
    TargetDate = U 0x76EE,0x6807,0x65E5,0x671F,0xFF1A
    Campus = U 0x6821,0x533A,0xFF1A
    Court = U 0x573A,0x5730,0xFF1A
    Time = U 0x65F6,0x95F4,0x6BB5,0xFF1A
    Submitted = U 0x662F,0x5426,0x63D0,0x4EA4,0x9884,0x7EA6,0xFF1A
    Paid = U 0x662F,0x5426,0x652F,0x4ED8,0x6210,0x529F,0xFF1A
    FailureReason = U 0x5931,0x8D25,0x63A5,0x53E3,0x2F,0x9875,0x9762,0x539F,0x56E0,0xFF1A
    TaskName = U 0x4EFB,0x52A1,0x540D,0xFF1A
    ResultFile = U 0x7ED3,0x679C,0x6587,0x4EF6,0xFF1A
    LogFile = U 0x65E5,0x5FD7,0x6587,0x4EF6,0xFF1A
    FinalPage = U 0x6700,0x7EC8,0x9875,0x9762,0xFF1A
}
if (-not $SubjectPrefix) {
    $SubjectPrefix = $Text.SubjectPrefix
}

if (-not (Test-Path -LiteralPath $ResultPath)) {
    throw "Result file not found: $ResultPath"
}
if (-not (Test-Path -LiteralPath $CredentialSecureStringPath)) {
    throw "SMTP credential file not found: $CredentialSecureStringPath"
}

$result = Read-ResultJson -Path $ResultPath

$slot = $result.slot
$targetDate = Get-ValueOrEmpty $slot.targetDate
if (-not $targetDate -and $result.run) {
    $targetDate = Get-ValueOrEmpty $result.run.targetDate
}
if (-not $targetDate) {
    $targetDate = (Get-Date).ToString("yyyy-MM-dd")
}

$campusCode = Get-ValueOrEmpty $slot.campus
if (-not $campusCode -and $result.run) {
    $campusCode = Get-ValueOrEmpty $result.run.primaryCampus
}
$campus = switch ($campusCode) {
    "xlh" { $Text.Xilihu }
    "lxd" { $Text.Liuxiandong }
    default { $campusCode }
}
if (-not $campus) { $campus = $Text.Unknown }

$court = Repair-Mojibake (Get-ValueOrEmpty $slot.court)
if (-not $court) { $court = $Text.Unknown }

$times = @()
if ($slot.times) {
    $times = @($slot.times | ForEach-Object { Get-ValueOrEmpty $_ })
}
if ($times.Count -eq 0 -and $slot.start -and $slot.end) {
    $times = @("$($slot.start)-$($slot.end)")
}
$timeText = if ($times.Count -gt 0) { $times -join ", " } else { $Text.Unknown }

$success = [bool]$result.success
$status = if ($success) { $Text.Success } else { $Text.Failure }
$submitted = if ($slot) { $Text.Yes } else { $Text.No }
$paid = if ($success) { $Text.Yes } else { $Text.No }

$failureReason = Repair-Mojibake (Get-ValueOrEmpty $result.failureReason)
if (-not $failureReason -and $result.attempts) {
    $lastAttempt = @($result.attempts)[-1]
    $failureReason = Repair-Mojibake (Get-ValueOrEmpty $lastAttempt.reason)
}
if (-not $failureReason) { $failureReason = $Text.None }

$subject = "$SubjectPrefix $targetDate - $status"
$lines = @(
    "$($Text.TargetDate)$targetDate",
    "$($Text.Campus)$campus",
    "$($Text.Court)$court",
    "$($Text.Time)$timeText",
    "$($Text.Submitted)$submitted",
    "$($Text.Paid)$paid",
    "$($Text.FailureReason)$failureReason"
)
if ($TaskName) { $lines += "$($Text.TaskName)$TaskName" }
$lines += "$($Text.ResultFile)$ResultPath"
if ($LogPath) { $lines += "$($Text.LogFile)$LogPath" }
if ($result.finalUrl) { $lines += "$($Text.FinalPage)$($result.finalUrl)" }
$body = $lines -join "`r`n"

$rawSecurePassword = (Get-Content -LiteralPath $CredentialSecureStringPath -Raw).Trim().TrimStart([char]0xfeff)
$securePassword = $rawSecurePassword | ConvertTo-SecureString
$credential = [pscredential]::new($From, $securePassword)
$message = [System.Net.Mail.MailMessage]::new()
$client = $null
try {
    $message.From = [System.Net.Mail.MailAddress]::new($From)
    $message.To.Add($To)
    $message.Subject = $subject
    $message.SubjectEncoding = [System.Text.Encoding]::UTF8
    $message.Body = $body
    $message.BodyEncoding = [System.Text.Encoding]::UTF8
    $message.IsBodyHtml = $false

    $client = [System.Net.Mail.SmtpClient]::new($SmtpServer, $SmtpPort)
    $client.EnableSsl = $SmtpPort -ne 25
    $client.Credentials = $credential.GetNetworkCredential()
    $client.Send($message)

    [ordered]@{
        success = $true
        to = $To
        from = $From
        subject = $subject
    } | ConvertTo-Json -Depth 4
} finally {
    if ($client) { $client.Dispose() }
    $message.Dispose()
}
