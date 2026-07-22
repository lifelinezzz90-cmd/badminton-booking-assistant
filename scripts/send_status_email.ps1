param(
    [Parameter(Mandatory)]
    [string]$Subject,
    [Parameter(Mandatory)]
    [string]$BodyPath,
    [Parameter(Mandatory)]
    [string]$To,
    [Parameter(Mandatory)]
    [string]$From,
    [ValidateNotNullOrEmpty()]
    [string]$SmtpServer,
    [Parameter(Mandatory)]
    [int]$SmtpPort,
    [Parameter(Mandatory)]
    [string]$CredentialSecureStringPath
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path -LiteralPath $BodyPath)) {
    throw "Body file not found: $BodyPath"
}
if (-not (Test-Path -LiteralPath $CredentialSecureStringPath)) {
    throw "SMTP credential file not found: $CredentialSecureStringPath"
}

$body = [System.IO.File]::ReadAllText($BodyPath, [System.Text.Encoding]::UTF8)
$rawSecurePassword = (Get-Content -LiteralPath $CredentialSecureStringPath -Raw).Trim().TrimStart([char]0xfeff)
$securePassword = $rawSecurePassword | ConvertTo-SecureString
$credential = [pscredential]::new($From, $securePassword)

$message = [System.Net.Mail.MailMessage]::new()
$client = $null
try {
    $message.From = [System.Net.Mail.MailAddress]::new($From)
    $message.To.Add($To)
    $message.Subject = $Subject
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
        subject = $Subject
    } | ConvertTo-Json -Depth 4
} finally {
    if ($client) { $client.Dispose() }
    $message.Dispose()
}
