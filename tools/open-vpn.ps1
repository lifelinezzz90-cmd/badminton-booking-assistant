param(
    [string]$ShortcutPath = "",
    [int]$WaitSeconds = 10,
    [int]$ProbeIntervalSeconds = 5,
    [int]$RetryShortcutAfterSeconds = 20,
    [int]$RestartStaleAfterSeconds = 60
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

function Write-Step {
    param([string]$Message)
    "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $Message
}

function Resolve-EasyConnectShortcutPath {
    param([string]$CandidatePath)

    $shell = New-Object -ComObject WScript.Shell
    if ($CandidatePath -and (Test-Path -LiteralPath $CandidatePath)) {
        try {
            $shortcut = $shell.CreateShortcut($CandidatePath)
            if ([System.IO.Path]::GetFileName($shortcut.TargetPath) -ieq "EasyConnect.exe") {
                return $CandidatePath
            }
        } catch {}
    }

    $roots = @(
        (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs"),
        (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs")
    )
    foreach ($rootPath in $roots) {
        if (-not (Test-Path -LiteralPath $rootPath)) { continue }
        $shortcuts = Get-ChildItem -LiteralPath $rootPath -Recurse -Filter "*EasyConnect*.lnk" -ErrorAction SilentlyContinue
        foreach ($shortcutFile in $shortcuts) {
            try {
                $target = $shell.CreateShortcut($shortcutFile.FullName).TargetPath
                if ([System.IO.Path]::GetFileName($target) -ieq "EasyConnect.exe") {
                    return $shortcutFile.FullName
                }
            } catch {}
        }
    }
    return $null
}

function Open-EasyConnectShortcut {
    param([Parameter(Mandatory)][string]$ResolvedShortcutPath)
    Write-Step "Opening EasyConnect via Start Menu shortcut; direct executable launch is avoided. shortcut=$ResolvedShortcutPath"
    Start-Process -FilePath "explorer.exe" -ArgumentList "`"$ResolvedShortcutPath`""
}

function Show-EasyConnectWindow {
    $process = @(Get-Process -Name "EasyConnect" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1)
    if ($process.Count -eq 0) { return $false }
    $signature = @"
using System;
using System.Runtime.InteropServices;
public static class Win32Window {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
    if (-not [System.Management.Automation.PSTypeName]'Win32Window'.Type) {
        Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue | Out-Null
    }
    [Win32Window]::ShowWindowAsync($process[0].MainWindowHandle, 5) | Out-Null
    [Win32Window]::SetForegroundWindow($process[0].MainWindowHandle) | Out-Null
    return $true
}

function Restart-StaleEasyConnect {
    Write-Step "EasyConnect is running without an authenticated tunnel; stopping stale client processes before shortcut relaunch."
    $staleProcesses = @(Get-Process -Name "EasyConnect","SangforCSClient" -ErrorAction SilentlyContinue)
    foreach ($process in $staleProcesses) {
        try {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            Write-Step "Stopped stale process $($process.ProcessName) pid=$($process.Id)."
        } catch {
            Write-Step "Failed to stop stale process $($process.ProcessName) pid=$($process.Id): $($_.Exception.Message)"
        }
    }
    Start-Sleep -Seconds 3
}

$resolvedShortcutPath = Resolve-EasyConnectShortcutPath -CandidatePath $ShortcutPath
if (-not $resolvedShortcutPath) {
    throw "EasyConnect shortcut not found; refusing direct executable launch to avoid VPN anomaly."
}

$deadline = (Get-Date).AddSeconds([Math]::Max(1, $WaitSeconds))
$lastState = $null
$lastShortcutAttempt = [datetime]::MinValue
$openedOnce = $false
$staleRestarted = $false
$unauthenticatedSince = [datetime]::MinValue

while ((Get-Date) -lt $deadline) {
    $running = @(Get-Process -Name "EasyConnect" -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) {
        Open-EasyConnectShortcut -ResolvedShortcutPath $resolvedShortcutPath
        $openedOnce = $true
        $lastShortcutAttempt = Get-Date
    } elseif (-not $openedOnce) {
        Write-Step "EasyConnect already running; focusing it and waiting for an authenticated tunnel."
        if (-not (Show-EasyConnectWindow)) {
            Write-Step "EasyConnect has no foreground window; reopening the Start Menu shortcut once to surface/connect it."
            Open-EasyConnectShortcut -ResolvedShortcutPath $resolvedShortcutPath
            $lastShortcutAttempt = Get-Date
        }
        $openedOnce = $true
    } elseif (((Get-Date) - $lastShortcutAttempt).TotalSeconds -ge $RetryShortcutAfterSeconds) {
        Write-Step "EasyConnect is still unauthenticated; retrying the Start Menu shortcut to recover a stale login window."
        Open-EasyConnectShortcut -ResolvedShortcutPath $resolvedShortcutPath
        $lastShortcutAttempt = Get-Date
    }

    $vpnState = Test-VpnAuthenticated
    $lastState = $vpnState
    if ($vpnState.ok) {
        Write-Step "VPN authenticated tunnel detected: $($vpnState.ips -join '; ')"
        exit 0
    }
    if ($unauthenticatedSince -eq [datetime]::MinValue) {
        $unauthenticatedSince = Get-Date
    }
    if (-not $staleRestarted -and $openedOnce -and $RestartStaleAfterSeconds -gt 0 -and ((Get-Date) - $unauthenticatedSince).TotalSeconds -ge $RestartStaleAfterSeconds) {
        Restart-StaleEasyConnect
        $staleRestarted = $true
        $openedOnce = $false
        $lastShortcutAttempt = [datetime]::MinValue
        $unauthenticatedSince = [datetime]::MinValue
        continue
    }
    Write-Step "VPN not authenticated yet; adapters=$($vpnState.adapters -join '; ') ips=$($vpnState.ips -join '; ')"
    Start-Sleep -Seconds ([Math]::Max(1, $ProbeIntervalSeconds))
}

$after = @(Get-Process -Name "EasyConnect" -ErrorAction SilentlyContinue)
if ($after.Count -eq 0) {
    throw "VPN_NOT_AUTHENTICATED: EasyConnect Start Menu shortcut was opened, but EasyConnect.exe was not detected before timeout."
}
throw "VPN_NOT_AUTHENTICATED: EasyConnect is running but no authenticated Sangfor SSL VPN 10.x tunnel was detected before timeout=$WaitSeconds seconds. adapters=$($lastState.adapters -join '; ') ips=$($lastState.ips -join '; ')"
