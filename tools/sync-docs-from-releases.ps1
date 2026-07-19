# Pulls the documentation down from the PUBLIC releases repo into this (source) repo.
#
# Direction is deliberate: since 2026-07 the docs are authored in
# fatalihue/TrueReplayer-releases — that is the repo users actually land on — and this
# repo receives copies. Never edit the guides here and expect them to survive; edit them
# there, push, then run this.
#
# The four doc files are kept BYTE-IDENTICAL between the repos so this stays a plain copy
# (that is why the Chrome-extension link is the absolute github.com URL in both, rather
# than the relative path the releases repo could otherwise use).
#
#   .\tools\sync-docs-from-releases.ps1                      # assumes ..\TrueReplayer-releases
#   .\tools\sync-docs-from-releases.ps1 -ReleasesRepo D:\x   # or point it somewhere else
#   .\tools\sync-docs-from-releases.ps1 -Check               # report drift, change nothing

[CmdletBinding()]
param(
    [string]$ReleasesRepo = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\TrueReplayer-releases'),
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$target = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path $ReleasesRepo)) {
    throw "Releases repo not found at '$ReleasesRepo'. Clone it next to this repo, or pass -ReleasesRepo."
}
$ReleasesRepo = (Resolve-Path $ReleasesRepo).Path

# Docs + the assets the docs embed. extension-setup/ and LICENSE are intentionally absent:
# the extension guide lives only in the releases repo, and LICENSE must not drift by copy.
$items = @(
    'README.md',
    'README.en.md',
    'docs/GUIDE.md',
    'docs/GUIDE.en.md',
    'docs/img/clicker.png',
    'docs/img/conditionals.png',
    'docs/img/hotkey.png',
    'docs/img/main.png',
    'docs/img/sendtext.png',
    'docs/img/target.png',
    'docs/img/theme.png',
    'Assets/Square150x150Logo.png'
)

$changed = @()
$missing = @()

foreach ($rel in $items) {
    $src = Join-Path $ReleasesRepo $rel
    $dst = Join-Path $target $rel

    if (-not (Test-Path $src)) { $missing += $rel; continue }

    $differs = $true
    if (Test-Path $dst) {
        $differs = (Get-FileHash $src).Hash -ne (Get-FileHash $dst).Hash
    }
    if (-not $differs) { continue }

    $changed += $rel
    if (-not $Check) {
        $dstDir = Split-Path $dst -Parent
        if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force $dstDir | Out-Null }
        Copy-Item $src $dst -Force
    }
}

if ($missing.Count -gt 0) {
    Write-Warning "Not present in the releases repo (skipped): $($missing -join ', ')"
}

if ($changed.Count -eq 0) {
    Write-Host "Docs already in sync with $ReleasesRepo" -ForegroundColor Green
} elseif ($Check) {
    Write-Host "Out of sync ($($changed.Count)):" -ForegroundColor Yellow
    $changed | ForEach-Object { Write-Host "  $_" }
    Write-Host "Run without -Check to copy them down."
} else {
    Write-Host "Updated $($changed.Count) file(s) from $ReleasesRepo" -ForegroundColor Green
    $changed | ForEach-Object { Write-Host "  $_" }
    Write-Host "Review with 'git diff', then commit."
}
