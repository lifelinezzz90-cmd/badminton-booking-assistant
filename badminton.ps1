[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("help", "setup", "doctor", "schedule", "status", "config", "dashboard", "uninstall")]
    [string]$Command = "help",
    [string]$ConfigPath = "config/local.json",
    [string]$TargetDate = "",
    [string]$Start = "",
    [string]$End = "",
    [string]$Username = "",
    [string]$PrimaryCampus = "",
    [string]$FallbackCampus = "",
    [string]$CourtPriorityLxd = "",
    [string]$CourtPriorityXlh = "",
    [string]$VpnShortcutPath = "",
    [string]$MailProvider = "",
    [string]$MailAddress = "",
    [string]$MailTo = "",
    [string]$SmtpServer = "",
    [int]$SmtpPort = 0,
    [switch]$EnableMail,
    [switch]$DisableMail,
    [switch]$EnableAutoPayment,
    [switch]$DisableAutoPayment,
    [switch]$PlanOnly,
    [switch]$Yes,
    [switch]$Json,
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$script:ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:CommandExitCode = 0
. (Join-Path $script:ProjectRoot "tools\common.ps1")

function Resolve-LocalConfigPath {
    return Resolve-ProjectPath -Root $script:ProjectRoot -Path $ConfigPath
}

function Read-LocalConfigObject {
    $path = Resolve-LocalConfigPath
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Local configuration not found: $path. Run .\badminton.ps1 setup first."
    }
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8).TrimStart([char]0xfeff)
    return $text | ConvertFrom-Json
}

function Set-ObjectProperty {
    param([Parameter(Mandatory)]$Object, [Parameter(Mandatory)][string]$Name, $Value)
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Get-OrCreateChildObject {
    param([Parameter(Mandatory)]$Object, [Parameter(Mandatory)][string]$Name)
    $property = $Object.PSObject.Properties[$Name]
    if ($property -and $null -ne $property.Value) { return $property.Value }
    $child = [pscustomobject]@{}
    Set-ObjectProperty -Object $Object -Name $Name -Value $child
    return $child
}

function Read-Choice {
    param(
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string[]]$Allowed,
        [Parameter(Mandatory)][string]$Default
    )
    while ($true) {
        $answer = (Read-Host "$Prompt [$Default]").Trim().ToLowerInvariant()
        if (-not $answer) { return $Default }
        if ($answer -in $Allowed) { return $answer }
        Write-Warning ("Allowed values: " + ($Allowed -join ", "))
    }
}

function Confirm-Action {
    param([Parameter(Mandatory)][string]$Prompt)
    if ($Yes) { return $true }
    return (Read-Host $Prompt).Trim() -ieq "y"
}

function Set-DpapiSecretInteractive {
    param([Parameter(Mandatory)][string]$RelativePath, [Parameter(Mandatory)][string]$Prompt)
    $resolved = Resolve-ProjectPath -Root $script:ProjectRoot -Path $RelativePath
    $directory = Split-Path -Parent $resolved
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $encrypted = $secure | ConvertFrom-SecureString
    if ([string]::IsNullOrWhiteSpace($encrypted)) { throw "Secret encryption failed." }
    [System.IO.File]::WriteAllText($resolved, $encrypted, [System.Text.Encoding]::ASCII)
    [void](Test-DpapiSecret -Path $resolved -RequireNonEmpty)
}

function Find-VpnShortcut {
    $roots = @()
    if ($env:ProgramData) { $roots += Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs" }
    if ($env:APPDATA) { $roots += Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs" }
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $match = Get-ChildItem -LiteralPath $root -Filter "*.lnk" -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "EasyConnect|Sangfor|SSLVPN" } |
            Sort-Object @{ Expression = { $_.FullName.Length } }, FullName |
            Select-Object -First 1
        if ($match) { return $match.FullName }
    }
    return ""
}

function Write-LocalConfig {
    param([Parameter(Mandatory)]$Value)
    Write-JsonFile -Value $Value -Path (Resolve-LocalConfigPath) -Depth 20
}

function New-MinimalLocalConfig {
    param([string]$Account, [string]$Primary, [string]$Fallback)
    return [pscustomobject][ordered]@{
        version = 1
        username = $Account
        primaryCampus = $Primary
        fallbackCampus = $Fallback
    }
}

function Get-MailSettings {
    param($ExistingMail)
    $provider = $MailProvider.Trim().ToLowerInvariant()
    if (-not $provider -and $ExistingMail -and $ExistingMail.provider) { $provider = [string]$ExistingMail.provider }
    if (-not $provider) { $provider = Read-Choice -Prompt "Mail provider (163/qq/custom)" -Allowed @("163", "qq", "custom") -Default "163" }
    if ($provider -notin @("163", "qq", "custom")) { throw "MailProvider must be 163, qq, or custom." }

    $address = $MailAddress.Trim()
    if (-not $address -and $ExistingMail -and $ExistingMail.address) { $address = [string]$ExistingMail.address }
    if (-not $address) { $address = (Read-Host "Sender email address").Trim() }
    if (-not $address) { throw "Mail address is required when mail is enabled." }

    $recipient = $MailTo.Trim()
    if (-not $recipient -and $ExistingMail -and $ExistingMail.to) { $recipient = [string]$ExistingMail.to }
    if (-not $recipient) { $recipient = $address }

    $server = $SmtpServer.Trim()
    $portValue = $SmtpPort
    if ($provider -eq "163") {
        if (-not $server) { $server = "smtp.163.com" }
        if ($portValue -le 0) { $portValue = 465 }
    } elseif ($provider -eq "qq") {
        if (-not $server) { $server = "smtp.qq.com" }
        if ($portValue -le 0) { $portValue = 465 }
    } else {
        if (-not $server -and $ExistingMail -and $ExistingMail.smtpServer) { $server = [string]$ExistingMail.smtpServer }
        if (-not $server) { $server = (Read-Host "SMTP server").Trim() }
        if ($portValue -le 0 -and $ExistingMail -and $ExistingMail.smtpPort) { $portValue = [int]$ExistingMail.smtpPort }
        if ($portValue -le 0) {
            $portText = (Read-Host "SMTP TLS port [465]").Trim()
            $portValue = if ($portText) { [int]$portText } else { 465 }
        }
    }
    if (-not $server -or $portValue -le 0) { throw "A valid SMTP server and port are required." }

    return [pscustomobject][ordered]@{
        enabled = $true
        provider = $provider
        address = $address
        to = $recipient
        smtpServer = $server
        smtpPort = $portValue
        secretPath = "secrets/smtp_authorization.dpapi.txt"
    }
}

function Invoke-Setup {
    $path = Resolve-LocalConfigPath
    $existing = $null
    if (Test-Path -LiteralPath $path) {
        $existing = Read-LocalConfigObject
        if (-not (Confirm-Action -Prompt "Update the existing local configuration? [y/N]")) {
            Write-Host "Setup cancelled; no files were changed."
            return
        }
    }

    $account = $Username.Trim()
    if (-not $account -and $existing -and $existing.username) { $account = [string]$existing.username }
    if (-not $account) { $account = (Read-Host "Booking account").Trim() }
    if (-not $account) { throw "Username is required." }

    $primary = $PrimaryCampus.Trim().ToLowerInvariant()
    if (-not $primary -and $existing -and $existing.primaryCampus) { $primary = [string]$existing.primaryCampus }
    if (-not $primary) { $primary = Read-Choice -Prompt "Primary campus (lxd/xlh)" -Allowed @("lxd", "xlh") -Default "lxd" }
    if ($primary -notin @("lxd", "xlh")) { throw "PrimaryCampus must be lxd or xlh." }

    $defaultFallback = if ($primary -eq "lxd") { "xlh" } else { "lxd" }
    $fallback = $FallbackCampus.Trim().ToLowerInvariant()
    if (-not $fallback -and $existing -and $existing.fallbackCampus) { $fallback = [string]$existing.fallbackCampus }
    if (-not $fallback) { $fallback = Read-Choice -Prompt "Fallback campus (lxd/xlh/none)" -Allowed @("lxd", "xlh", "none") -Default $defaultFallback }
    if ($fallback -notin @("lxd", "xlh", "none", "auto") -or $fallback -eq $primary) { throw "FallbackCampus must differ from PrimaryCampus." }

    $local = if ($existing) { $existing } else { New-MinimalLocalConfig -Account $account -Primary $primary -Fallback $fallback }
    Set-ObjectProperty -Object $local -Name "version" -Value 1
    Set-ObjectProperty -Object $local -Name "username" -Value $account
    Set-ObjectProperty -Object $local -Name "primaryCampus" -Value $primary
    Set-ObjectProperty -Object $local -Name "fallbackCampus" -Value $fallback

    $detectedVpn = Find-VpnShortcut
    if ($detectedVpn) {
        Write-Host "EasyConnect shortcut detected automatically; no machine-specific path was saved."
    } else {
        $manualPath = $VpnShortcutPath.Trim()
        if (-not $manualPath -and -not $Yes) { $manualPath = (Read-Host "EasyConnect .lnk path (optional)").Trim('"').Trim() }
        if ($manualPath) {
            $resolvedVpn = [System.IO.Path]::GetFullPath($manualPath)
            if (-not (Test-Path -LiteralPath $resolvedVpn -PathType Leaf) -or [System.IO.Path]::GetExtension($resolvedVpn) -ine ".lnk") {
                throw "VpnShortcutPath must point to an existing .lnk file."
            }
            $vpn = Get-OrCreateChildObject -Object $local -Name "vpn"
            Set-ObjectProperty -Object $vpn -Name "shortcutPath" -Value $resolvedVpn
        }
    }

    Write-LocalConfig -Value $local

    $passwordPath = Resolve-ProjectPath -Root $script:ProjectRoot -Path "secrets/cas_password.dpapi.txt"
    if (-not (Test-Path -LiteralPath $passwordPath)) {
        Set-DpapiSecretInteractive -RelativePath "secrets/cas_password.dpapi.txt" -Prompt "Booking password (stored with Windows DPAPI)"
    } else {
        Write-Host "Existing DPAPI booking password kept."
    }

    $enableMailNow = [bool]$EnableMail
    if (-not $EnableMail -and -not $DisableMail -and -not $Yes) {
        $enableMailNow = Confirm-Action -Prompt "Enable completion email now? [y/N]"
    }
    if ($enableMailNow) {
        $mail = Get-MailSettings -ExistingMail $local.mail
        Set-ObjectProperty -Object $local -Name "mail" -Value $mail
        Write-LocalConfig -Value $local
        Set-DpapiSecretInteractive -RelativePath "secrets/smtp_authorization.dpapi.txt" -Prompt "SMTP authorization code (stored with Windows DPAPI)"
    } elseif ($DisableMail -and $local.PSObject.Properties["mail"]) {
        Set-ObjectProperty -Object $local.mail -Name "enabled" -Value $false
        Write-LocalConfig -Value $local
    }

    Write-Host "Setup complete: $path"
    Write-Host "Next: .\badminton.ps1 doctor"
}

function New-DoctorCheck {
    param([string]$Name, [string]$Status, [string]$Detail)
    return [pscustomobject][ordered]@{ name = $Name; status = $Status; detail = $Detail }
}

function Invoke-Doctor {
    $checks = New-Object System.Collections.Generic.List[object]
    $effective = $null
    try {
        $effective = Read-BookingConfig -ConfigPath $ConfigPath
        $checks.Add((New-DoctorCheck -Name "Configuration" -Status "ok" -Detail "Canonical configuration resolved."))
    } catch {
        $checks.Add((New-DoctorCheck -Name "Configuration" -Status "fail" -Detail $_.Exception.Message))
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $version = (& $node.Source --version 2>$null | Select-Object -First 1)
        $checks.Add((New-DoctorCheck -Name "Node.js" -Status "ok" -Detail ([string]$version)))
    } else {
        $checks.Add((New-DoctorCheck -Name "Node.js" -Status "fail" -Detail "node.exe was not found in PATH."))
    }

    $programFiles = [Environment]::GetEnvironmentVariable("ProgramFiles")
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    $chromeCandidates = @()
    if ($programFiles) { $chromeCandidates += Join-Path $programFiles "Google\Chrome\Application\chrome.exe" }
    if ($programFilesX86) { $chromeCandidates += Join-Path $programFilesX86 "Google\Chrome\Application\chrome.exe" }
    if ($env:LOCALAPPDATA) { $chromeCandidates += Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe" }
    $chromeCandidates = @($chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    if ($chromeCandidates.Count -gt 0) {
        $checks.Add((New-DoctorCheck -Name "Google Chrome" -Status "ok" -Detail "Installed."))
    } else {
        $checks.Add((New-DoctorCheck -Name "Google Chrome" -Status "fail" -Detail "Chrome executable was not found."))
    }

    if ($effective) {
        $bridgePath = [string]$effective.webBridgeExecutablePath
        if ($bridgePath -and (Test-Path -LiteralPath $bridgePath -PathType Leaf)) {
            $checks.Add((New-DoctorCheck -Name "Kimi WebBridge" -Status "ok" -Detail "Executable found."))
        } else {
            $checks.Add((New-DoctorCheck -Name "Kimi WebBridge" -Status "fail" -Detail "Executable not found. Install and pair WebBridge first."))
        }

        $passwordPath = Resolve-ProjectPath -Root $script:ProjectRoot -Path ([string]$effective.passwordSecret)
        try {
            [void](Test-DpapiSecret -Path $passwordPath -RequireNonEmpty)
            $checks.Add((New-DoctorCheck -Name "Booking secret" -Status "ok" -Detail "DPAPI secret decrypts for the current Windows user."))
        } catch {
            $checks.Add((New-DoctorCheck -Name "Booking secret" -Status "fail" -Detail $_.Exception.Message))
        }

        $vpnShortcut = [string]$effective.easyConnectShortcutPath
        if ($vpnShortcut -and (Test-Path -LiteralPath $vpnShortcut -PathType Leaf)) {
            $checks.Add((New-DoctorCheck -Name "EasyConnect" -Status "ok" -Detail "Shortcut discovered."))
        } else {
            $checks.Add((New-DoctorCheck -Name "EasyConnect" -Status "fail" -Detail "Shortcut not found; run config -VpnShortcutPath <file.lnk>."))
        }

        if ([bool]$effective.mailOnCompletion) {
            $mailSecretPath = Resolve-ProjectPath -Root $script:ProjectRoot -Path ([string]$effective.smtpSecret)
            try {
                [void](Test-DpapiSecret -Path $mailSecretPath -RequireNonEmpty)
                $checks.Add((New-DoctorCheck -Name "Mail" -Status "ok" -Detail "Enabled; SMTP DPAPI secret is readable."))
            } catch {
                $checks.Add((New-DoctorCheck -Name "Mail" -Status "fail" -Detail $_.Exception.Message))
            }
        } else {
            $checks.Add((New-DoctorCheck -Name "Mail" -Status "skip" -Detail "Disabled by default."))
        }

        try {
            Invoke-WebRequest -Uri ([string]$effective.vpnProbeUrl) -UseBasicParsing -Method Head -TimeoutSec 8 -ErrorAction Stop | Out-Null
            $checks.Add((New-DoctorCheck -Name "Venue access" -Status "ok" -Detail "Venue endpoint is reachable."))
        } catch {
            $checks.Add((New-DoctorCheck -Name "Venue access" -Status "warn" -Detail "Endpoint is not reachable yet; connect EasyConnect and retry."))
        }
    }

    if ($Json) { $checks | ConvertTo-Json -Depth 5 } else { $checks | Format-Table -AutoSize | Out-Host }
    if (@($checks | Where-Object { $_.status -eq "fail" }).Count -gt 0) { $script:CommandExitCode = 1 }
}

function Invoke-Config {
    $local = Read-LocalConfigObject
    $changed = $false

    if ($Username) { Set-ObjectProperty -Object $local -Name "username" -Value $Username.Trim(); $changed = $true }
    if ($PrimaryCampus) {
        $value = $PrimaryCampus.Trim().ToLowerInvariant()
        if ($value -notin @("lxd", "xlh")) { throw "PrimaryCampus must be lxd or xlh." }
        Set-ObjectProperty -Object $local -Name "primaryCampus" -Value $value
        $changed = $true
    }
    if ($FallbackCampus) {
        $value = $FallbackCampus.Trim().ToLowerInvariant()
        if ($value -notin @("lxd", "xlh", "none", "auto")) { throw "FallbackCampus must be lxd, xlh, none, or auto." }
        Set-ObjectProperty -Object $local -Name "fallbackCampus" -Value $value
        $changed = $true
    }
    if ($CourtPriorityLxd -or $CourtPriorityXlh) {
        $priority = Get-OrCreateChildObject -Object $local -Name "courtPriority"
        if ($CourtPriorityLxd) { Set-ObjectProperty -Object $priority -Name "lxd" -Value $CourtPriorityLxd }
        if ($CourtPriorityXlh) { Set-ObjectProperty -Object $priority -Name "xlh" -Value $CourtPriorityXlh }
        $changed = $true
    }
    if ($VpnShortcutPath) {
        $resolvedVpn = [System.IO.Path]::GetFullPath($VpnShortcutPath.Trim('"'))
        if (-not (Test-Path -LiteralPath $resolvedVpn -PathType Leaf) -or [System.IO.Path]::GetExtension($resolvedVpn) -ine ".lnk") {
            throw "VpnShortcutPath must point to an existing .lnk file."
        }
        $vpn = Get-OrCreateChildObject -Object $local -Name "vpn"
        Set-ObjectProperty -Object $vpn -Name "shortcutPath" -Value $resolvedVpn
        $changed = $true
    }
    if ($EnableMail -and $DisableMail) { throw "Choose either EnableMail or DisableMail." }
    if ($EnableMail) {
        $mail = Get-MailSettings -ExistingMail $local.mail
        Set-ObjectProperty -Object $local -Name "mail" -Value $mail
        Write-LocalConfig -Value $local
        Set-DpapiSecretInteractive -RelativePath "secrets/smtp_authorization.dpapi.txt" -Prompt "SMTP authorization code (stored with Windows DPAPI)"
        $changed = $true
    } elseif ($DisableMail) {
        $mail = Get-OrCreateChildObject -Object $local -Name "mail"
        Set-ObjectProperty -Object $mail -Name "enabled" -Value $false
        $changed = $true
    }
    if ($EnableAutoPayment -and $DisableAutoPayment) { throw "Choose either EnableAutoPayment or DisableAutoPayment." }
    if ($EnableAutoPayment) {
        $risk = (Read-Host "Auto-payment can submit a real charge. Type ENABLE AUTO PAYMENT to continue").Trim()
        if ($risk -cne "ENABLE AUTO PAYMENT") { throw "Auto-payment was not enabled." }
        $payment = Get-OrCreateChildObject -Object $local -Name "payment"
        Set-ObjectProperty -Object $payment -Name "autoConfirm" -Value $true
        $changed = $true
    } elseif ($DisableAutoPayment) {
        $payment = Get-OrCreateChildObject -Object $local -Name "payment"
        Set-ObjectProperty -Object $payment -Name "autoConfirm" -Value $false
        $changed = $true
    }

    if (-not $changed) {
        $effective = Read-BookingConfig -ConfigPath $ConfigPath
        [ordered]@{
            configPath = Resolve-LocalConfigPath
            accountConfigured = -not [string]::IsNullOrWhiteSpace([string]$effective.username)
            primaryCampus = [string]$effective.primaryCampus
            fallbackCampus = [string]$effective.fallbackCampus
            courtPriority = [ordered]@{ lxd = [string]$effective.lxdCourtPriority; xlh = [string]$effective.xlhCourtPriority }
            vpnDetected = [bool]$effective.easyConnectShortcutPath
            mailEnabled = [bool]$effective.mailOnCompletion
            paymentAutoConfirm = [bool]$effective.paymentAutoConfirm
        } | ConvertTo-Json -Depth 6
        Write-Host "Use config parameters to update settings. See docs\configuration.md."
        return
    }

    Write-LocalConfig -Value $local
    [void](Read-BookingConfig -ConfigPath $ConfigPath)
    Write-Host "Configuration updated and validated: $(Resolve-LocalConfigPath)"
}

function Invoke-Schedule {
    if (-not $TargetDate -or -not $Start -or -not $End) { throw "schedule requires -TargetDate yyyy-MM-dd -Start HH:mm -End HH:mm." }
    $target = [datetime]::ParseExact($TargetDate, "yyyy-MM-dd", $null)
    $runDate = $target.AddDays(-1).ToString("yyyy-MM-dd")
    $arguments = @{
        ConfigPath = $ConfigPath
        RunDate = $runDate
        TargetDate = $TargetDate
        DesiredStartTime = $Start
        DesiredEndTime = $End
        InstallSource = "badminton-cli"
        PlanOnly = $true
    }
    $effective = Read-BookingConfig -ConfigPath $ConfigPath -Overrides @{ desiredStartTime = $Start; desiredEndTime = $End }
    if (-not [bool]$effective.paymentAutoConfirm) { $arguments["NoConfirmPayment"] = $true }
    $installer = Join-Path $script:ProjectRoot "tools\install-next-formal-run.ps1"
    $planText = & $installer @arguments
    if ($LASTEXITCODE -ne 0) { throw "Plan generation failed." }
    $planText | Out-Host
    if ($PlanOnly) { return }
    if (-not (Confirm-Action -Prompt "Install the five scheduled tasks shown above? [y/N]")) {
        Write-Host "Cancelled; scheduled tasks were not changed."
        return
    }
    $arguments.Remove("PlanOnly")
    & $installer @arguments
    if ($LASTEXITCODE -ne 0) { throw "Scheduled task installation failed." }
}

function Invoke-Status {
    $prefix = Get-ProjectTaskPrefix
    $tasks = @()
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
        $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like ($prefix + "*") } | Sort-Object TaskName)
    }
    $taskRows = @($tasks | ForEach-Object {
        $info = Get-ScheduledTaskInfo -TaskName $_.TaskName -TaskPath $_.TaskPath
        [pscustomobject][ordered]@{
            taskName = $_.TaskName
            state = [string]$_.State
            nextRunTime = if ($info.NextRunTime) { $info.NextRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" }
            lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" }
            lastResult = [int]$info.LastTaskResult
        }
    })
    $logDir = Join-Path $script:ProjectRoot "logs"
    $latest = $null
    if (Test-Path -LiteralPath $logDir) {
        $latest = Get-ChildItem -LiteralPath $logDir -Filter "booking_*.result.json" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
    $result = $null
    if ($latest) {
        try {
            $raw = Get-Content -LiteralPath $latest.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            $result = [ordered]@{ file = $latest.Name; success = [bool]$raw.success; failureReason = [string]$raw.failureReason; run = $raw.run; slot = $raw.slot }
        } catch {
            $result = [ordered]@{ file = $latest.Name; error = $_.Exception.Message }
        }
    }
    if ($Json) {
        [ordered]@{ tasks = $taskRows; latestResult = $result } | ConvertTo-Json -Depth 10
    } else {
        if ($taskRows.Count) { $taskRows | Format-Table -AutoSize | Out-Host } else { Write-Host "No Badminton Booking Assistant tasks are installed." }
        if ($result) { Write-Host "Latest result:"; $result | ConvertTo-Json -Depth 8 | Out-Host }
    }
}

function Invoke-Dashboard {
    $url = "http://127.0.0.1:$Port/"
    Start-Process $url | Out-Null
    & node (Join-Path $script:ProjectRoot "scripts\ui_server.mjs") ("--port=" + $Port)
}

function Invoke-Uninstall {
    $prefix = Get-ProjectTaskPrefix
    $tasks = @()
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
        $tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like ($prefix + "*") })
    }
    if (-not $tasks.Count) { Write-Host "No project-owned scheduled tasks were found."; return }
    $tasks | Select-Object TaskName, State | Format-Table -AutoSize | Out-Host
    if (-not (Confirm-Action -Prompt "Delete only the Badminton Booking Assistant tasks above? [y/N]")) { Write-Host "Cancelled."; return }
    foreach ($task in $tasks) { Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false }
    Write-Host ("Removed " + $tasks.Count + " project-owned tasks. Other scheduled tasks were not touched.")
}

function Show-Help {
    @"
Badminton Booking Assistant

  .\badminton.ps1 setup
  .\badminton.ps1 doctor
  .\badminton.ps1 schedule -TargetDate 2026-07-29 -Start 19:30 -End 21:00 -PlanOnly
  .\badminton.ps1 status
  .\badminton.ps1 config [-EnableAutoPayment]
  .\badminton.ps1 dashboard
  .\badminton.ps1 uninstall

Documentation: docs\installation.md and docs\configuration.md
"@ | Write-Host
}

try {
    switch ($Command) {
        "setup" { Invoke-Setup }
        "doctor" { Invoke-Doctor }
        "schedule" { Invoke-Schedule }
        "status" { Invoke-Status }
        "config" { Invoke-Config }
        "dashboard" { Invoke-Dashboard }
        "uninstall" { Invoke-Uninstall }
        default { Show-Help }
    }
} catch {
    Write-Error $_.Exception.Message
    $script:CommandExitCode = 1
}

exit $script:CommandExitCode
