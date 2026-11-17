# Run a live evaluation (100 labelled receipts) against your Kaggle OCR service, then print the report.
# The URL and key are typed here, in YOUR terminal. The key is not echoed and is not written to any file.
# Usage (from receipt-portal):  powershell -ExecutionPolicy Bypass -File .\eval\run100.ps1
param([int]$N = 100, [int]$Seed = 1)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$env:MINICPM_URL = (Read-Host 'Kaggle OCR URL (https://xxxx.trycloudflare.com)').Trim()
$secure = Read-Host 'Key (typing is hidden)' -AsSecureString
$env:MINICPM_KEY = [System.Net.NetworkCredential]::new('', $secure).Password
$second = (Read-Host 'Second model URL, e.g. <url>/m2 (press Enter to skip)').Trim()
if ($second) { $env:MINICPM2_URL = $second }

Write-Host ''
Write-Host "Running $N receipts (seed $Seed). Safe to stop with Ctrl+C; re-run with --resume to continue."
bun eval/run-live.ts --n $N --seed $Seed
if ($LASTEXITCODE -ne 0) { Write-Host 'run-live stopped early (see message above).'; }

$latest = Get-ChildItem eval/runs/run-*.json -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) {
  Write-Host ''
  Write-Host "Report for $($latest.Name):"
  bun eval/report.ts --runs $latest.FullName --mismatches
}
Remove-Item Env:MINICPM_KEY -ErrorAction SilentlyContinue
