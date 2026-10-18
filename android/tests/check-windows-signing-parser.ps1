# Read-only syntax check. Does not execute the launcher, tools, or signing.
$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot '..\scripts\Sign-bcorn.ps1'
$tokens = $null
$errors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.ToString() }; exit 1 }
Write-Host 'PowerShell syntax valid. Native prompts, ACLs and signing remain untested by this check.'
