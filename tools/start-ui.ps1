param(
    [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$root = Get-ProjectRoot
& node (Join-Path $root "scripts\ui_server.mjs") "--port=$Port"
