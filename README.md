# codex-badminton

Windows automation for booking badminton courts through a campus venue system. The unattended production path uses Kimi WebBridge, an existing VPN connection or EasyConnect shortcut, campus CAS login, configured campus/court priorities, optional automatic payment, result logs, and email notification.

> This repository contains source code and a non-sensitive example configuration only. Accounts, email addresses, credentials, cookies, generated booking configs, and logs must remain local.

## Privacy model

Safe to commit:

- `config/config.example.json`: complete configuration template with placeholder values.
- `scripts/`, `tools/`, and `web/`: project source code.
- `README.md`: setup and variable documentation.

Ignored and never intended for GitHub:

- `config/local.json`: real account, email, machine paths, and booking preferences.
- `config/local.*.json` and `config/local-presets/`: alternate local configurations.
- `config/generated/`: effective configs generated for scheduled runs.
- `secrets/`: DPAPI-encrypted CAS passwords, SMTP authorization codes, and session snapshots.
- `logs/`, `*.log`, and `*.result.json`: runtime evidence, booking results, and mail logs.
- `.env*` and `node_modules/`: local environment files and dependencies.

Do not commit DPAPI files even though they are encrypted. They are intended to be decrypted only by the same Windows logon identity that created them.

## Quick start

### 1. Create the private local config

```powershell
Copy-Item .\config\config.example.json .\config\local.json
notepad .\config\local.json
```

`config/local.json` is ignored by Git. Never put real values back into `config/config.example.json`.

### 2. Fill the required variables

At minimum, review and fill these values:

| Variable | Required when | Value |
| --- | --- | --- |
| `username` | Always | Campus CAS account. |
| `passwordSecret` | Always | Local DPAPI file containing the CAS password, for example `secrets/cas_password.dpapi.txt`. |
| `sessionSnapshotSecret` | Recommended | Local DPAPI file used for the encrypted CAS session snapshot. |
| `smtpSecret` | `mailOnCompletion=true` | Local DPAPI file containing the SMTP authorization code. |
| `mailTo` | `mailOnCompletion=true` | Result email recipient. |
| `mailFrom` | `mailOnCompletion=true` | SMTP sender address. |
| `smtpServer` | `mailOnCompletion=true` | SMTP host supplied by the mail provider. |
| `smtpPort` | `mailOnCompletion=true` | SMTP port supplied by the mail provider. |
| `vpnProbeUrl` | `openVpn=true` | Business URL that is reachable only when the VPN is ready. |
| `easyConnectShortcutPath` | `openVpn=true` | Absolute path of the local EasyConnect Start Menu shortcut. |
| `primaryCampus` | Always | First campus to try, such as `lxd`. |
| `fallbackCampus` | When fallback is wanted | Fallback campus, or `none` to disable campus fallback. |
| `lxdCourtPriority` | When LXD is used | LXD court priority, comma-separated. |
| `xlhCourtPriority` | When XLH is used | XLH court priority, comma-separated. |
| `desiredStartTime` | Always | Requested start time in `HH:mm` format. |
| `desiredEndTime` | Always | Requested end time in `HH:mm` format. |

### 3. Create encrypted local credentials

CAS password:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\set-secret.ps1 `
  -Path .\secrets\cas_password.dpapi.txt `
  -Prompt "Enter CAS password" `
  -Verify
```

SMTP authorization code:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\set-secret.ps1 `
  -Path .\secrets\smtp_authorization.dpapi.txt `
  -Prompt "Enter SMTP authorization code" `
  -Verify
```

Never store plaintext passwords or authorization codes in JSON, scripts, README files, shell history, or Git commits.

### 4. Run local checks

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\test-project.ps1 `
  -ConfigPath .\config\local.json
```

Validate the proven production profile:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\assert-success-profile.ps1 `
  -ConfigPath .\config\local.json
```

### 5. Preflight and install scheduled tasks

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\precheck.ps1 `
  -ConfigPath .\config\local.json `
  -RunDate 2026-07-22 `
  -TargetDate 2026-07-23
```

Preview the next formal install:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\install-next-formal-run.ps1 `
  -ConfigPath .\config\local.json `
  -PlanOnly
```

Install after reviewing the plan:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\install-next-formal-run.ps1 `
  -ConfigPath .\config\local.json
```

The installer creates the WebBridge prestart, VPN preconnect, preflight, booking, and postcheck tasks. The effective config is embedded into installed task arguments, so later changes to the example config do not alter an already-installed run.

## Complete configuration reference

### Identity, secrets, and email

| Variable | Type | Description |
| --- | --- | --- |
| `username` | string | CAS account. Keep the real value only in `config/local.json`. |
| `passwordSecret` | path | DPAPI file containing the CAS password. |
| `sessionSnapshotSecret` | path | DPAPI file containing a reusable encrypted session snapshot. |
| `smtpSecret` | path | DPAPI file containing the SMTP authorization code. |
| `mailTo` | string | Result email recipient. |
| `mailFrom` | string | SMTP sender. |
| `smtpServer` | string | SMTP hostname. |
| `smtpPort` | integer | SMTP port. |
| `mailOnCompletion` | boolean | Send a result email after each run. |

### Campus, courts, time, and payment

| Variable | Type | Description |
| --- | --- | --- |
| `taskName` | string | Windows Task Scheduler name prefix. |
| `primaryCampus` | string | First campus: `lxd` or `xlh`. |
| `fallbackCampus` | string | `lxd`, `xlh`, `auto`, or `none`. |
| `lxdCourtPriority` | CSV string | LXD court order. |
| `xlhCourtPriority` | CSV string | XLH court order. |
| `desiredStartTime` | `HH:mm` | Requested start time. |
| `desiredEndTime` | `HH:mm` | Requested end time. |
| `maxBookingMinutes` | integer | Maximum duration to book. |
| `maxBookingAmount` | number | Maximum allowed payment amount. |
| `partialMinMinutes` | integer | Minimum continuous duration for partial fallback. |
| `disablePartialFallback` | boolean | Disable partial-duration fallback when `true`. |
| `maxPaymentAttempts` | integer | Maximum automatic payment attempts. |

### Scheduling, polling, and selection strategy

| Variable | Type | Description |
| --- | --- | --- |
| `readyDeadline` | `HH:mm:ss` | Deadline for the support chain to be ready. |
| `taskStartTime` | `HH:mm:ss` | Booking task start time. |
| `pollStartTime` | `HH:mm:ss` | Time to begin availability polling. |
| `pollUntilTime` | `HH:mm:ss` | Time to stop polling. |
| `pollIntervalMs` | integer | Poll interval in milliseconds. |
| `fallbackAfterMisses` | integer | Misses before campus fallback is allowed. |
| `partialFallbackStartTime` | `HH:mm:ss` | Earliest time for partial-duration fallback. |
| `partialFallbackAfterMisses` | integer | Misses before partial-duration fallback is allowed. |
| `fastRefreshDelayMs` | integer | Delay after a fast page refresh. |
| `fastRefreshTimeoutMs` | integer | Fast refresh timeout. |
| `fastSelectDelayMs` | integer | Short delay before selecting a court. |
| `primaryCampusHoldSeconds` | integer | Time reserved for the primary campus before fallback. |
| `minPollingStay` | integer | Minimum polling iterations before switching branches. |
| `staleStateTrigger` | integer | Unchanged states before recovery logic is triggered. |
| `missLogEvery` | integer | Log every N misses to reduce log volume. |
| `pageWaitSeconds` | integer | Maximum page/login wait time. |
| `wakeToRun` | boolean | Allow Task Scheduler to wake the computer. |

### VPN and browser

| Variable | Type | Description |
| --- | --- | --- |
| `openVpn` | boolean | Start/check VPN as part of the scheduled chain. |
| `vpnLaunchMode` | string | The supported production mode is `explorer_shortcut`. |
| `vpnPostLaunchWaitSeconds` | integer | Wait after starting VPN. |
| `vpnProbeUrl` | URL | Business URL used to prove VPN connectivity. |
| `vpnReadyTimeoutSeconds` | integer | VPN readiness timeout. |
| `easyConnectAppPattern` | regex string | EasyConnect process/window match expression. |
| `easyConnectShortcutPath` | path | EasyConnect Start Menu shortcut. |
| `browserMode` | string | The unattended production path uses `webbridge`. |

## Environment variables

These variables are optional and are only needed when default installation paths or ports do not apply:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `KIMI_WEBBRIDGE_EXE` | `%USERPROFILE%\.kimi-webbridge\bin\kimi-webbridge.exe` | Override the Kimi WebBridge executable. |
| `CODEX_HOME` | `%USERPROFILE%\.codex` | Override the Codex home directory. |
| `CODEX_PLUGIN_CACHE_ROOT` | `%CODEX_HOME%\plugins\cache` | Override the Codex plugin cache directly. |
| `PORT` | `8787` | Local dashboard port. |

`CODEX_YDSZ_SNAPSHOT_B64` is an internal temporary process variable. Do not set or persist it manually.

## Common commands

Start the local dashboard:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\start-ui.ps1
```

The default address is `http://127.0.0.1:8787/`.

Manual dry run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\run-booking.ps1 `
  -ConfigPath .\config\local.json `
  -RunDate 2026-07-22 `
  -TargetDate 2026-07-23 `
  -DryRun
```

Manual production run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\run-booking.ps1 `
  -ConfigPath .\config\local.json `
  -RunDate 2026-07-22 `
  -TargetDate 2026-07-23
```

## Project layout

- `scripts/booking_logic.mjs`: booking decisions and page-injected functions.
- `scripts/webbridge_runner.mjs`: unattended Kimi WebBridge orchestration.
- `scripts/codex_plugin_runner.mjs`: Codex Chrome/Computer Use rescue path.
- `scripts/ui_server.mjs`: local dashboard API and static server.
- `tools/install-next-formal-run.ps1`: calculate and install the next complete task chain.
- `tools/install-task.ps1`: install one dated Task Scheduler run.
- `tools/precheck.ps1`: VPN, WebBridge, credential, CAS, and venue checks.
- `tools/postcheck.ps1`: require a fresh result and notify on missing results.
- `tools/test-project.ps1`: source and local runtime checks.
- `tools/set-secret.ps1`: create a DPAPI secret for the current Windows identity.
- `web/`: dashboard frontend.

## Security guardrails

- Never commit plaintext passwords, authorization codes, cookies, tokens, real accounts, private email addresses, or phone numbers.
- Never commit `config/local.json`, `secrets/`, `logs/`, or `config/generated/`.
- The production polling and selection path uses page logic, not screenshot coordinates.
- VPN startup uses a verified Start Menu shortcut and does not directly launch an unknown executable.
- Do not open CAS until the VPN business probe succeeds.
- Scheduled tasks must run under the same Windows identity that created the DPAPI files.
- Locking or sleeping with wake enabled can work; logging out prevents tasks that use an interactive logon token from running.
- Before pushing, run tests, scan for secrets, and inspect `git diff --cached` for local configs and runtime evidence.
