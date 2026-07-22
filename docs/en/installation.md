# Installation

## Requirements

Windows 10/11, PowerShell 5.1+, Node.js 20+, Google Chrome, Kimi WebBridge, EasyConnect, and valid access to the supported venue system.

## First run

```powershell
.\badminton.ps1 setup
```

Do not edit JSON before the first run. The setup wizard explains every prompt:

1. **Unified-login/CAS account**: the account normally used to sign in to the booking system, often a student or staff ID. It is not a GitHub account.
2. **Login password**: the matching password. Input is hidden and stored with Windows DPAPI, never in `config/local.json`.
3. **Primary and fallback venue**: select the prompted codes. Fallback remains enabled by default.
4. **EasyConnect shortcut**: Start Menu discovery runs automatically. If it fails, setup opens a picker for the `.lnk` shortcut; do not select the `.exe`.

To find the shortcut manually, search for EasyConnect in the Windows Start Menu, right-click it, choose “Open file location,” and select the resulting `.lnk` file.

```powershell
.\badminton.ps1 config -UpdatePassword
.\badminton.ps1 config -SelectVpnShortcut
```

Mail stays disabled during normal setup. Enable it later with `.\badminton.ps1 config -EnableMail`.

## Check the installation

```powershell
.\badminton.ps1 doctor
```

`doctor` checks Node, Chrome, WebBridge, the VPN shortcut, DPAPI credentials, and venue connectivity.

## Preview and install

```powershell
.\badminton.ps1 schedule -TargetDate 2026-07-29 -Start 19:30 -End 21:00 -PlanOnly
```

Review the five-task plan, then rerun without `-PlanOnly`. Only `BadmintonBookingAssistant_*` tasks are managed.
