$ErrorActionPreference = "Stop"
try {
    $script:Utf8NoBomEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = $script:Utf8NoBomEncoding
    [Console]::OutputEncoding = $script:Utf8NoBomEncoding
} catch {
}

function Get-ProjectRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Resolve-ProjectPath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Path
    )
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $Root $Path))
}

function Read-BookingConfig {
    param(
        [Parameter(Mandatory)][string]$ConfigPath,
        [string]$ConfigJsonBase64 = ""
    )
    $root = Get-ProjectRoot
    $resolved = Resolve-ProjectPath -Root $root -Path $ConfigPath
    if ($ConfigJsonBase64) {
        $jsonText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigJsonBase64))
        $config = $jsonText | ConvertFrom-Json
    } else {
        if (-not (Test-Path -LiteralPath $resolved)) {
            throw "Config not found: $resolved"
        }
        $jsonText = [System.IO.File]::ReadAllText($resolved, [System.Text.Encoding]::UTF8).TrimStart([char]0xfeff)
        $config = $jsonText | ConvertFrom-Json
    }
    $config | Add-Member -NotePropertyName "_configPath" -NotePropertyValue $resolved -Force
    return $config
}

function Get-DateOnly {
    param($Value, [datetime]$Default)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
        return $Default.Date
    }
    return ([datetime]::Parse([string]$Value)).Date
}

function Get-TimeOnDate {
    param(
        [Parameter(Mandatory)][datetime]$Date,
        [Parameter(Mandatory)][string]$TimeText
    )
    return [datetime]::ParseExact($Date.ToString("yyyy-MM-dd") + " " + $TimeText, "yyyy-MM-dd HH:mm:ss", $null)
}

function ConvertTo-Hashtable {
    param($Object)
    $hash = [ordered]@{}
    foreach ($property in $Object.PSObject.Properties) {
        if ($property.Name.StartsWith("_")) { continue }
        $hash[$property.Name] = $property.Value
    }
    return $hash
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Path,
        [int]$Depth = 12
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $json = $Value | ConvertTo-Json -Depth $Depth
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Test-PowerShellSyntax {
    param([Parameter(Mandatory)][string]$Path)
    $tokens = $null
    $errs = $null
    [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errs) | Out-Null
    if ($errs -and $errs.Count) {
        $messages = ($errs | ForEach-Object { $_.Message }) -join " | "
        throw "PowerShell syntax failed for ${Path}: $messages"
    }
}

function Test-DpapiSecret {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$RequireNonEmpty
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Secret file not found: $Path"
    }
    $raw = (Get-Content -LiteralPath $Path -Raw).Trim().TrimStart([char]0xfeff)
    if (-not $raw) {
        throw "Secret file is empty: $Path"
    }
    $secure = $raw | ConvertTo-SecureString
    $credential = [System.Management.Automation.PSCredential]::new("codex", $secure)
    $plain = $credential.GetNetworkCredential().Password
    if ($RequireNonEmpty -and [string]::IsNullOrEmpty($plain)) {
        throw "Secret decrypts to an empty value: $Path"
    }
    return [pscustomobject]@{
        path = $Path
        length = $plain.Length
    }
}

function Test-VpnAuthenticated {
    $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
        $_.InterfaceDescription -match "Sangfor|EasyConnect|SSL VPN" -or
        $_.Name -match "Sangfor|EasyConnect|SSL|VPN"
    })
    $upAdapters = @($adapters | Where-Object { $_.Status -eq "Up" })
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        ($_.InterfaceAlias -in @($upAdapters | Select-Object -ExpandProperty Name)) -and
        $_.IPAddress -match "^10\."
    })
    return [pscustomobject]@{
        ok = ($upAdapters.Count -gt 0 -and $ips.Count -gt 0)
        adapters = @($upAdapters | ForEach-Object { "$($_.Name) [$($_.InterfaceDescription)] $($_.Status)" })
        ips = @($ips | ForEach-Object { "$($_.InterfaceAlias)=$($_.IPAddress)/$($_.PrefixLength)" })
    }
}

function New-RunKey {
    param(
        [Parameter(Mandatory)][datetime]$RunDate,
        [Parameter(Mandatory)][datetime]$TargetDate,
        [Parameter(Mandatory)]$Config
    )
    $start = ([string]$Config.desiredStartTime).Replace(":", "")
    $end = ([string]$Config.desiredEndTime).Replace(":", "")
    return "booking_{0}_0745_for_{1}_{2}_{3}_{4}" -f `
        $RunDate.ToString("yyyyMMdd"),
        $TargetDate.ToString("yyyyMMdd"),
        ([string]$Config.primaryCampus).ToLowerInvariant(),
        $start,
        $end
}

function Resolve-RunPrefix {
    param(
        [Parameter(Mandatory)][string]$LogDir,
        [Parameter(Mandatory)][string]$RunKey
    )
    $candidate = Join-Path $LogDir $RunKey
    if (-not (Test-Path -LiteralPath "$candidate.result.json") -and -not (Test-Path -LiteralPath "$candidate.log")) {
        return $candidate
    }
    $suffix = (Get-Date).ToString("yyyyMMdd_HHmmss")
    return (Join-Path $LogDir "${RunKey}_rerun_$suffix")
}

function New-SyntheticResult {
    param(
        [Parameter(Mandatory)][bool]$Success,
        [Parameter(Mandatory)][string]$FailureReason,
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][datetime]$RunDate,
        [Parameter(Mandatory)][datetime]$TargetDate,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][string]$ErrPath
    )
    return [ordered]@{
        success = $Success
        failureReason = $FailureReason
        run = [ordered]@{
            runDate = $RunDate.ToString("yyyy-MM-dd")
            targetDate = $TargetDate.ToString("yyyy-MM-dd")
            desiredStartTime = [string]$Config.desiredStartTime
            desiredEndTime = [string]$Config.desiredEndTime
            primaryCampus = [string]$Config.primaryCampus
            fallbackCampus = [string]$Config.fallbackCampus
        }
        logPath = $LogPath
        errPath = $ErrPath
    }
}

function Send-ResultMail {
    param(
        [Parameter(Mandatory)]$Config,
        [Parameter(Mandatory)][string]$ResultPath,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][string]$MailLogPath,
        [Parameter(Mandatory)][string]$TaskName
    )
    $root = Get-ProjectRoot
    $mailScript = Join-Path $root "scripts\send_booking_result_email.ps1"
    $smtpSecret = Resolve-ProjectPath -Root $root -Path ([string]$Config.smtpSecret)
    $mailOut = "$MailLogPath.out"
    $mailErr = "$MailLogPath.err"
    Remove-Item -LiteralPath $MailLogPath, $mailOut, $mailErr -Force -ErrorAction SilentlyContinue
    try {
        $output = & $mailScript `
            -ResultPath $ResultPath `
            -LogPath $LogPath `
            -To ([string]$Config.mailTo) `
            -From ([string]$Config.mailFrom) `
            -SmtpServer ([string]$Config.smtpServer) `
            -SmtpPort ([int]$Config.smtpPort) `
            -CredentialSecureStringPath $smtpSecret `
            -TaskName $TaskName 2>&1
        $output | Set-Content -LiteralPath $MailLogPath -Encoding UTF8
    } catch {
        $message = "Mail send failed: $($_.Exception.Message)"
        $message | Set-Content -LiteralPath $MailLogPath -Encoding UTF8
        throw $message
    }
}
