<#
.SYNOPSIS
  One-shot bump + Velopack pack + GitHub release for TrueReplayer (x64).

.DESCRIPTION
  Collapses the whole manual release checklist into a single command. Bumps the
  version in all 5 files, builds the frontend, publishes x64, generates the delta
  against the LAST PUBLISHED release, packs, commits + pushes the bump, and creates
  the GitHub release with exactly the 6 auto-update assets. Every historical footgun
  (RELEASES BOM, delta-base detection, the exe file lock, --channel, git add -A) is
  handled automatically.

.PARAMETER Version
  Target version: an explicit X.Y.Z, or one of patch | minor | major (auto-bump
  from the current package.json version).

.PARAMETER Notes
  Path to a markdown release-notes file. If omitted, notes are auto-generated from
  the commit subjects since the previous "chore: bump version" commit.

.PARAMETER Draft
  Create the GitHub release as a --draft instead of published --latest.
  (A direct release is LIVE by default - Velopack auto-update fires for everyone.)

.PARAMETER DryRun
  Do everything LOCAL (bump, build, publish, pack) but stop before the 3 outward /
  irreversible steps: git commit, git push, gh release create. Leaves the bumped
  files + built artifacts for inspection and prints the commands it WOULD have run.

.EXAMPLE
  .\release.ps1 2.7.4
.EXAMPLE
  .\release.ps1 patch -Notes relnotes.md
.EXAMPLE
  .\release.ps1 2.7.4 -DryRun
#>
param(
  [Parameter(Mandatory = $true, Position = 0)] [string] $Version,
  [string] $Notes,
  [switch] $Draft,
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# -- constants --
$RelRepo    = 'fatalihue/TrueReplayer-releases'
$PubProfile = 'Properties/PublishProfiles/win-x64.pubxml'
$UTF8NoBom  = New-Object System.Text.UTF8Encoding($false)
$UTF8Bom    = New-Object System.Text.UTF8Encoding($true)

# -- helpers --
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Info($m) { Write-Host "  $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !   $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "`nFAIL: $m" -ForegroundColor Red; exit 1 }
function NativeCheck($what) { if ($LASTEXITCODE -ne 0) { Fail "$what (exit $LASTEXITCODE)" } }

# Literal, assert-present replacement across a file, written UTF-8 (no BOM).
function ReplaceInFile($path, [hashtable]$map) {
  $raw = [System.IO.File]::ReadAllText((Resolve-Path $path))
  foreach ($k in $map.Keys) {
    if (-not $raw.Contains($k)) { Fail "in $path : expected string not found -> '$k' (version files drifted?)" }
    $raw = $raw.Replace($k, $map[$k])
  }
  [System.IO.File]::WriteAllText((Resolve-Path $path), $raw, $UTF8NoBom)
}

function Require($tool) { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "'$tool' not found on PATH" } }

# ==========================================================================
Step "Preflight"
Require git; Require gh; Require dotnet; Require npm; Require vpk

# current version (source of truth = frontend/package.json)
$pkgRaw = [System.IO.File]::ReadAllText((Resolve-Path 'frontend/package.json'))
if ($pkgRaw -notmatch '"version":\s*"(\d+\.\d+\.\d+)"') { Fail "could not read current version from frontend/package.json" }
$current = $Matches[1]

# compute the new version
if ($Version -in @('patch','minor','major')) {
  $p = $current.Split('.'); $maj = [int]$p[0]; $min = [int]$p[1]; $pat = [int]$p[2]
  switch ($Version) {
    'major' { $maj++; $min = 0; $pat = 0 }
    'minor' { $min++; $pat = 0 }
    'patch' { $pat++ }
  }
  $new = "$maj.$min.$pat"
} elseif ($Version -match '^\d+\.\d+\.\d+$') {
  $new = $Version
} else {
  Fail "Version must be X.Y.Z or one of patch|minor|major (got '$Version')"
}
$cur4 = "$current.0"; $new4 = "$new.0"
Info "current: $current   ->   new: $new $(if($DryRun){'  [DRY RUN]'})$(if($Draft){'  [DRAFT]'})"

# working tree must be clean (code already committed); only the 5 version files may
# be dirty from a prior aborted run. Match the EXACT tracked path (porcelain = 2 status
# chars + a space, then the path) so an unrelated dirty file whose path merely contains
# a version-file name (e.g. backup/app.manifest.orig) can't slip a dirty release through.
$verFiles = @('TrueReplayer.csproj','Package.appxmanifest','app.manifest','frontend/package.json','frontend/package-lock.json')
$dirty = (git status --porcelain --untracked-files=no) | Where-Object { $_ } | Where-Object { $verFiles -notcontains $_.Substring(3) }
if ($dirty) { Fail "working tree has uncommitted code changes - commit them first:`n$($dirty -join "`n")" }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Warn "not on 'main' (on '$branch') - releases normally go from main" }

# last PUBLISHED release = the delta base (NOT necessarily $current-1)
$prevTag = (gh release list --repo $RelRepo --limit 1 --json tagName --jq '.[0].tagName' 2>$null)
NativeCheck "gh release list"
if (-not $prevTag) { Fail "could not determine the last published release from $RelRepo" }
$prev = $prevTag.TrimStart('v')
Info "delta base (last published): $prev"
if ($prev -eq $new) { Fail "version $new is already the latest published release" }
Ok "preflight passed"

# ==========================================================================
Step "Bump version (5 files)"
ReplaceInFile 'TrueReplayer.csproj' @{
  "<Version>$current</Version>"               = "<Version>$new</Version>"
  "<AssemblyVersion>$cur4</AssemblyVersion>"  = "<AssemblyVersion>$new4</AssemblyVersion>"
  "<FileVersion>$cur4</FileVersion>"          = "<FileVersion>$new4</FileVersion>"
}
ReplaceInFile 'Package.appxmanifest' @{ "Version=`"$cur4`"" = "Version=`"$new4`"" }
ReplaceInFile 'app.manifest'         @{ "version=`"$cur4`"" = "version=`"$new4`"" }
ReplaceInFile 'frontend/package.json' @{ "`"version`": `"$current`"" = "`"version`": `"$new`"" }
Push-Location frontend; npm install --package-lock-only 2>&1 | Out-Null; $lc = $LASTEXITCODE; Pop-Location
if ($lc -ne 0) { Fail "npm install --package-lock-only (exit $lc)" }
# verify no BOM crept into package.json (breaks vite/postcss)
$b = [System.IO.File]::ReadAllBytes((Resolve-Path 'frontend/package.json'))
if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { Fail "frontend/package.json has a BOM" }
Ok "all 5 files at $new (no BOM)"

# ==========================================================================
Step "Build frontend + publish x64"
# close a running Build-Test instance that would lock the publish DLL
Get-Process TrueReplayer -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*\win-x64\publish\TrueReplayer.exe' } |
  ForEach-Object { Info "stopping running Build Test (PID $($_.Id))"; Stop-Process -Id $_.Id -Force }

Push-Location frontend; npm run build; $bc = $LASTEXITCODE; Pop-Location
if ($bc -ne 0) { Fail "frontend build (exit $bc)" }
Ok "frontend built"

dotnet publish TrueReplayer.csproj -c Release -p:PublishProfile=$PubProfile
NativeCheck "dotnet publish"
# NEWEST publish dir by write time (dotnet just wrote it) so a stale leftover TFM dir
# can't be packed; SilentlyContinue -> $null on zero matches so the guard below fires
# with a clear message instead of Resolve-Path throwing.
$publishDir = (Get-ChildItem 'bin/Release/*/win-x64/publish' -Directory -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
if (-not $publishDir) { Fail "publish output dir not found under bin/Release/*/win-x64/publish" }
Ok "published -> $publishDir"

# ==========================================================================
Step "Prepare delta base ($prev)"
Remove-Item -Recurse -Force releases -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path releases/default | Out-Null
gh release download $prevTag --repo $RelRepo --pattern "TrueReplayer-$prev-full.nupkg" --dir releases/default
NativeCheck "gh release download $prevTag"
$prevNupkg = "releases/default/TrueReplayer-$prev-full.nupkg"
if (-not (Test-Path $prevNupkg)) { Fail "previous nupkg not downloaded: $prevNupkg" }
$sha  = (Get-FileHash -Algorithm SHA1 $prevNupkg).Hash  # uppercase hex
$size = (Get-Item $prevNupkg).Length
# RELEASES MUST carry a UTF-8 BOM or vpk silently skips delta generation.
[System.IO.File]::WriteAllText((Resolve-Path 'releases/default').Path + '\RELEASES',
  "$sha TrueReplayer-$prev-full.nupkg $size`n", $UTF8Bom)
Ok "RELEASES written with BOM ($sha)"

# ==========================================================================
Step "vpk pack $new"
# -Width 4096 so Out-String never wraps the delta line across the host buffer width
# (~120 cols) and splits the phrase we grep for below.
$packOut = (vpk pack --packId TrueReplayer --packVersion $new `
  --packDir $publishDir --outputDir releases/default `
  --mainExe TrueReplayer.exe --icon TrueReplayer.ico --packTitle "TrueReplayer" 2>&1) | Out-String -Width 4096
Write-Host $packOut
NativeCheck "vpk pack"
# Match just 'Building delta' (literal, no version dots) so a wrapped line or a
# regex-metachar in the version can't false-abort a release that DID build the delta.
if ($packOut -notmatch 'Building delta') {
  Fail "delta was NOT generated ('Building delta ...' absent) - users would download the full ~200MB. Check the RELEASES base ($prev)."
}
Ok "delta $prev -> $new built"

# assemble the exact 6 auto-update assets
$assets = @(
  "releases/default/TrueReplayer-win-Setup.exe",
  "releases/default/TrueReplayer-$new-full.nupkg",
  "releases/default/TrueReplayer-$new-delta.nupkg",
  "releases/default/RELEASES",
  "releases/default/assets.win.json",
  "releases/default/releases.win.json"
)
foreach ($a in $assets) { if (-not (Test-Path $a)) { Fail "expected asset missing: $a" } }

# ==========================================================================
Step "Release notes"
if ($Notes) {
  if (-not (Test-Path $Notes)) { Fail "notes file not found: $Notes" }
  $notesFile = (Resolve-Path $Notes).Path
  Info "using $Notes"
} else {
  # auto-generate from commits since the previous bump commit
  $prevBump = (git log --grep='^chore: bump version' -n 1 --format='%H').Trim()
  $lines = @()
  if ($prevBump) { $lines = git log "$prevBump..HEAD" --no-merges --pretty='- %s' | Where-Object { $_ -notmatch '^- chore: bump version' } }
  if (-not $lines) { $lines = @("- Maintenance release.") }
  $notesFile = Join-Path $env:TEMP "trprofile-relnotes-$new.md"
  [System.IO.File]::WriteAllText($notesFile, "## TrueReplayer $new`n`n" + ($lines -join "`n") + "`n", $UTF8NoBom)
  Info "auto-generated from $(($lines | Measure-Object).Count) commit(s):"
  $lines | ForEach-Object { Info "    $_" }
}

# ==========================================================================
if ($DryRun) {
  Step "DRY RUN - stopping before commit / push / release"
  Warn "would run: git add <5 files> && git commit -m 'chore: bump version to $new' && git push origin main"
  $mode = if ($Draft) { '--draft' } else { '--latest' }
  Warn "would run: gh release create v$new --repo $RelRepo --title `"TrueReplayer $new`" $mode --notes-file `"$notesFile`" <6 assets>"
  # Revert the version bump so a leftover bumped-but-uncommitted tree can't double-bump a
  # later relative (patch/minor/major) run or no-op the commit. Build artifacts stay in ./releases.
  git checkout -- $verFiles 2>$null
  Info "DRY RUN complete - version files reverted; build artifacts left in ./releases for inspection."
  Info "  re-run without -DryRun to cut the real release."
  exit 0
}

Step "Commit + push bump"
git add TrueReplayer.csproj Package.appxmanifest app.manifest frontend/package.json frontend/package-lock.json
NativeCheck "git add"
git commit -m "chore: bump version to $new"
NativeCheck "git commit"
git push origin main
NativeCheck "git push"
Ok "pushed"

Step "Create GitHub release"
$ghArgs = @('release','create',"v$new",'--repo',$RelRepo,'--title',"TrueReplayer $new",'--notes-file',$notesFile)
if ($Draft) { $ghArgs += '--draft' } else { $ghArgs += '--latest' }
$ghArgs += $assets
gh @ghArgs
NativeCheck "gh release create"

# Parse gh's JSON in PowerShell (a --jq expression with \(...) interpolation gets its
# outer quotes stripped by PS arg-parsing and breaks jq).
$rel = (gh release view "v$new" --repo $RelRepo --json isDraft,isPrerelease,assets | ConvertFrom-Json)
Ok "release v$new created - isDraft=$($rel.isDraft) isPrerelease=$($rel.isPrerelease) assets=$($rel.assets.Count)"

Step "Cleanup"
Remove-Item -Recurse -Force releases -ErrorAction SilentlyContinue
Ok "done"

Write-Host "`nReleased TrueReplayer $new -> https://github.com/$RelRepo/releases/tag/v$new" -ForegroundColor Green
if ($Draft) { Write-Host "(DRAFT - publish it in the GitHub UI when ready)" -ForegroundColor Yellow }
