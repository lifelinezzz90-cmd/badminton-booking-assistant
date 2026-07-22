# Installation

## Requirements

Windows 10/11, PowerShell 5.1+, Node.js 20+, Google Chrome, Kimi WebBridge, EasyConnect, and valid access to the supported venue system.

## First run

```powershell
.\badminton.ps1 setup
.\badminton.ps1 doctor
```

`setup` creates the minimal local configuration and DPAPI-protected secrets. `doctor` checks Node, Chrome, WebBridge, VPN, credentials, and venue connectivity.

## Preview and install

```powershell
.\badminton.ps1 schedule -TargetDate 2026-07-29 -Start 19:30 -End 21:00 -PlanOnly
```

Review the five-task plan, then rerun without `-PlanOnly`. Only `BadmintonBookingAssistant_*` tasks are managed.
