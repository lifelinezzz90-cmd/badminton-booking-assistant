param([switch]$SkipNodeTests)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$failed = 0
function Check([string]$Name, [scriptblock]$Action) { try { & $Action; Write-Output ("[OK] " + $Name) } catch { $script:failed++; Write-Output ("[FAIL] " + $Name + " - " + $_.Exception.Message) } }
Check "node:available" { if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js was not found" }; node --version | Out-Null; if ($LASTEXITCODE -ne 0) { throw "node --version failed" } }
Check "powershell:syntax" { $errors = @(); Get-ChildItem -LiteralPath $root -Recurse -Filter *.ps1 -File | Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } | ForEach-Object { $tokens = $null; $parseErrors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors); if ($parseErrors) { $errors += $parseErrors | ForEach-Object { $_.Message + " (" + $_.Extent.File + ":" + $_.Extent.StartLineNumber + ")" } } }; if ($errors.Count) { throw ($errors -join "; ") } }
Check "config:four-field-example" { $config = Get-Content -LiteralPath (Join-Path $root "config\config.example.json") -Raw -Encoding UTF8 | ConvertFrom-Json; $names = @($config.psobject.Properties.Name | Sort-Object); $expected = @("fallbackCampus", "primaryCampus", "username", "version"); if (($names -join ',') -ne ($expected -join ',')) { throw "config.example.json must contain exactly four fields" } }
Check "security:ignored-runtime-files" { $ignore = Get-Content -LiteralPath (Join-Path $root ".gitignore") -Raw -Encoding UTF8; foreach ($entry in @("logs/", "secrets/", "config/generated/", "config/local.json")) { if ($ignore -notmatch [regex]::Escape($entry)) { throw "Missing .gitignore rule: $entry" } } }
if (-not $SkipNodeTests) { Check "node:test-suite" { Push-Location $root; try { & node --test tests/*.test.mjs; if ($LASTEXITCODE -ne 0) { throw "Node tests failed" } } finally { Pop-Location } } }
if ($failed -gt 0) { exit 1 }
Write-Output "[OK] project:self-check - all non-mutating checks passed"
