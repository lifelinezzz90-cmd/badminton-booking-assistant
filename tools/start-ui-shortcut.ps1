param(
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$url = "http://127.0.0.1:$Port/"
$apiUrl = "http://127.0.0.1:$Port/api/dashboard"
$outLog = Join-Path $logDir "ui_server.shortcut.out.log"
$errLog = Join-Path $logDir "ui_server.shortcut.err.log"

function Test-UiServer {
    try {
        $response = Invoke-WebRequest -Uri $apiUrl -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

if (-not (Test-UiServer)) {
    $node = (Get-Command node -ErrorAction Stop).Source
    Start-Process `
        -FilePath $node `
        -ArgumentList @((Join-Path $root "scripts\ui_server.mjs"), "--port=$Port") `
        -WorkingDirectory $root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog | Out-Null

    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 300
        if (Test-UiServer) { break }
    } while ((Get-Date) -lt $deadline)
}

Start-Process $url | Out-Null
