param(
    [int]$WaitSeconds = 30,
    [string]$ExtensionId = "fldmhceldgbpfpkbgopacenieobmligc"
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $Message
}

$webBridge = if ($env:KIMI_WEBBRIDGE_EXE) { $env:KIMI_WEBBRIDGE_EXE } else { Join-Path $env:USERPROFILE ".kimi-webbridge\bin\kimi-webbridge.exe" }
if (-not (Test-Path -LiteralPath $webBridge)) {
    throw "Kimi WebBridge executable not found: $webBridge"
}

function Get-WebBridgeStatus {
    $statusText = & $webBridge status
    try {
        return @{
            Text = $statusText
            Json = ($statusText | ConvertFrom-Json)
        }
    } catch {
        return @{
            Text = $statusText
            Json = $null
        }
    }
}

function Restart-StaleWebBridge {
    param($Status)
    if (-not $Status -or -not $Status.Json) { return $false }
    if ($Status.Json.running) { return $false }
    $pidValue = 0
    [void][int]::TryParse([string]$Status.Json.pid, [ref]$pidValue)
    if ($pidValue -gt 0 -and (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
        return $false
    }
    $pidFile = Join-Path $env:USERPROFILE ".kimi-webbridge\daemon.pid"
    if (Test-Path -LiteralPath $pidFile) {
        Write-Step "Removing stale Kimi WebBridge PID file: $pidFile"
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
    Write-Step "Restarting Kimi WebBridge daemon after stale status."
    & $webBridge restart | Out-Null
    return $true
}

Write-Step "Starting Kimi WebBridge daemon."
& $webBridge start | Out-Null
$initialStatus = Get-WebBridgeStatus
[void](Restart-StaleWebBridge -Status $initialStatus)

$popupUrl = "chrome-extension://$ExtensionId/popup.html"
$chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($chrome) {
    Write-Step "Opening Kimi WebBridge Chrome extension popup."
    Start-Process -FilePath $chrome -ArgumentList $popupUrl | Out-Null
} else {
    Write-Step "Chrome executable not found by fixed path; trying shell association."
    Start-Process $popupUrl | Out-Null
}

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $WaitSeconds))
do {
    Start-Sleep -Seconds 1
    $statusInfo = Get-WebBridgeStatus
    $statusText = $statusInfo.Text
    $status = $statusInfo.Json
    if ($status -and -not $status.running) {
        [void](Restart-StaleWebBridge -Status $statusInfo)
    }
    if ($status -and $status.running -and $status.extension_connected) {
        Write-Step "Kimi WebBridge extension connected. version=$($status.version) extension=$($status.extension_version)"
        exit 0
    }
} while ((Get-Date) -lt $deadline)

throw "Kimi WebBridge extension did not connect before timeout. status=$statusText"
