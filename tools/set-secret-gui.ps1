param(
    [Parameter(Mandatory)][string]$Path,
    [string]$Title = "Set secret",
    [string]$Label = "Enter secret"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Get-ProjectRoot
$resolved = Resolve-ProjectPath -Root $root -Path $Path
$dir = Split-Path -Parent $resolved
if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = "CenterScreen"
$form.Width = 460
$form.Height = 170
$form.TopMost = $true

$labelControl = New-Object System.Windows.Forms.Label
$labelControl.Text = $Label
$labelControl.Left = 16
$labelControl.Top = 18
$labelControl.Width = 410
$form.Controls.Add($labelControl)

$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Left = 16
$textBox.Top = 48
$textBox.Width = 410
$textBox.UseSystemPasswordChar = $true
$form.Controls.Add($textBox)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = "OK"
$ok.Left = 260
$ok.Top = 86
$ok.Width = 80
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.AcceptButton = $ok
$form.Controls.Add($ok)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = "Cancel"
$cancel.Left = 346
$cancel.Top = 86
$cancel.Width = 80
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.CancelButton = $cancel
$form.Controls.Add($cancel)

$result = $form.ShowDialog()
if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
    throw "Secret entry cancelled."
}
if ([string]::IsNullOrEmpty($textBox.Text)) {
    throw "Secret cannot be empty."
}

$secure = ConvertTo-SecureString -String $textBox.Text -AsPlainText -Force
$encrypted = $secure | ConvertFrom-SecureString
[System.IO.File]::WriteAllText($resolved, $encrypted, [System.Text.Encoding]::ASCII)

$check = Test-DpapiSecret -Path $resolved -RequireNonEmpty
[pscustomobject]@{
    ok = $true
    path = $resolved
    length = $check.length
} | ConvertTo-Json -Compress
