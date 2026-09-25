<#
.SYNOPSIS
  Edit the remote-control file for an extension and push it to the `updates` branch.

.EXAMPLE
  .\control.ps1 lobby-sweeper show
  .\control.ps1 lobby-sweeper disable-user jdoe "Paused while we fix the queue list — Mayowa"
  .\control.ps1 lobby-sweeper enable-user  jdoe
  .\control.ps1 lobby-sweeper disable-install 4f1c9a2b7e3d5f60 "This laptop is retired"
  .\control.ps1 lobby-sweeper enable-install  4f1c9a2b7e3d5f60
  .\control.ps1 lobby-sweeper disable-all "Sweeper paused for maintenance until 15:00"
  .\control.ps1 lobby-sweeper enable-all
  .\control.ps1 lobby-sweeper notice "New version 0.2.8 out — check for updates"
  .\control.ps1 lobby-sweeper notice ""
  .\control.ps1 lobby-sweeper min-version 0.2.8

  Slugs: lobby-sweeper | ms-viewer. Installs re-read the file within 15 minutes.
#>
param(
  [Parameter(Mandatory)][ValidateSet("lobby-sweeper", "ms-viewer")][string]$Slug,
  [Parameter(Mandatory)][ValidateSet("show", "disable-user", "enable-user", "disable-install", "enable-install", "disable-all", "enable-all", "notice", "min-version")][string]$Action,
  [string]$Target = "",
  [string]$Message = ""
)
$ErrorActionPreference = "Stop"
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe" }
$repo = "https://github.com/sparrrow1011/LTL_Viewer.git"
$work = Join-Path $env:TEMP "ltl-updates-branch"

if (Test-Path $work) { Remove-Item $work -Recurse -Force }
& $git clone --quiet --depth 1 --branch updates $repo $work
$file = Join-Path $work "$Slug\control.json"
if (-not (Test-Path $file)) { throw "no control.json for $Slug on the updates branch yet (run the sign workflow once first)" }
$doc = Get-Content $file -Raw | ConvertFrom-Json
if (-not $doc.users) { $doc | Add-Member -NotePropertyName users -NotePropertyValue ([pscustomobject]@{}) }
if (-not $doc.installs) { $doc | Add-Member -NotePropertyName installs -NotePropertyValue ([pscustomobject]@{}) }

function Set-Entry($map, $key, $enabled, $msg) {
  $key = $key.ToLower()
  $entry = [pscustomobject]@{ enabled = $enabled }
  if ($msg) { $entry | Add-Member -NotePropertyName message -NotePropertyValue $msg }
  if ($map.PSObject.Properties[$key]) { $map.$key = $entry } else { $map | Add-Member -NotePropertyName $key -NotePropertyValue $entry }
}

switch ($Action) {
  "show"            { $doc | ConvertTo-Json -Depth 5; return }
  "disable-user"    { if (-not $Target) { throw "alias required" }; Set-Entry $doc.users $Target $false $Message }
  "enable-user"     { if (-not $Target) { throw "alias required" }; $doc.users.PSObject.Properties.Remove($Target.ToLower()) }
  "disable-install" { if (-not $Target) { throw "install id required" }; Set-Entry $doc.installs $Target $false $Message }
  "enable-install"  { if (-not $Target) { throw "install id required" }; $doc.installs.PSObject.Properties.Remove($Target.ToLower()) }
  "disable-all"     { $doc.enabled = $false; $doc.message = if ($Target) { $Target } else { $Message } }
  "enable-all"      { $doc.enabled = $true; $doc.message = "" }
  "notice"          { $doc.notice = $Target }
  "min-version"     { if (-not $Target) { throw "version required" }; $doc.minVersion = $Target }
}

($doc | ConvertTo-Json -Depth 5) + "`n" | Set-Content $file -Encoding UTF8
Push-Location $work
try {
  & $git add "$Slug/control.json"
  & $git -c user.name="control.ps1" -c user.email="mayowas@amazon.com" commit --quiet -m "$Slug control: $Action $Target" 
  & $git push --quiet origin updates
  Write-Host "pushed. Installs pick it up within 15 min (or on their next Run / Re-check)." -ForegroundColor Green
  $doc | ConvertTo-Json -Depth 5
} finally { Pop-Location }
