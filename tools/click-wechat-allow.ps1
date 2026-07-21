param(
    [int]$MaxAttempts = 1,
    [int]$DelayMs = 300,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class User32WechatAllow {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$SW_RESTORE = 9

function Get-WechatWindow {
    $windows = @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
        Where-Object { $_.MainWindowTitle -match '^(微信|WeChat)$|微信|WeChat' })
    if (-not $windows.Count) {
        return $null
    }
    $exact = @($windows | Where-Object { $_.MainWindowTitle -eq "微信" -or $_.MainWindowTitle -eq "WeChat" })
    if ($exact.Count) {
        return $exact[0]
    }
    return $windows[0]
}

$attempts = New-Object System.Collections.Generic.List[object]
for ($i = 1; $i -le $MaxAttempts; $i++) {
    $proc = Get-WechatWindow
    if (-not $proc) {
        $attempts.Add([ordered]@{ attempt = $i; ok = $false; reason = "wechat window not found" }) | Out-Null
        Start-Sleep -Milliseconds $DelayMs
        continue
    }

    $rect = New-Object User32WechatAllow+RECT
    $okRect = [User32WechatAllow]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
    if (-not $okRect) {
        $attempts.Add([ordered]@{ attempt = $i; ok = $false; reason = "GetWindowRect failed"; processId = $proc.Id; title = $proc.MainWindowTitle }) | Out-Null
        Start-Sleep -Milliseconds $DelayMs
        continue
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 300 -or $height -lt 300) {
        $attempts.Add([ordered]@{ attempt = $i; ok = $false; reason = "wechat window too small"; processId = $proc.Id; title = $proc.MainWindowTitle; width = $width; height = $height }) | Out-Null
        Start-Sleep -Milliseconds $DelayMs
        continue
    }

    # The WeChat OAuth permission dialog is centered in the main WeChat window.
    # The green Allow button is about 80px left and 57px below the dialog/window center.
    $x = [int]($rect.Left + [Math]::Round(($width / 2) - 80))
    $y = [int]($rect.Top + [Math]::Round(($height / 2) + 57))

    if (-not $DryRun) {
        [User32WechatAllow]::ShowWindow($proc.MainWindowHandle, $SW_RESTORE) | Out-Null
        [User32WechatAllow]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 150
        [User32WechatAllow]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 50
        [User32WechatAllow]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        [User32WechatAllow]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    }

    $attempts.Add([ordered]@{
        attempt = $i
        ok = $true
        dryRun = [bool]$DryRun
        processId = $proc.Id
        title = $proc.MainWindowTitle
        x = $x
        y = $y
        width = $width
        height = $height
    }) | Out-Null
    break
}

[ordered]@{
    ok = [bool]($attempts | Where-Object { $_.ok } | Select-Object -First 1)
    attempts = $attempts
} | ConvertTo-Json -Depth 5
