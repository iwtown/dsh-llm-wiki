# dsh-llm-wiki installer for DSH Desktop on Windows.
# Usage:
#   .\install.ps1                  # plugin + skills + 9 scripts + 4 scheduled tasks
#   .\install.ps1 -NoSchedule      # skip scheduled tasks
#   .\install.ps1 -Uninstall       # remove installed files/tasks (patch is left untouched)
#   .\install.ps1 -ProfileName web # install into another DSH profile
param(
  [switch]$NoSchedule,
  [switch]$Uninstall,
  [string]$ProfileName = 'desktop',
  [string]$TaskPrefix = '',
  [string]$Vault = $(if ($env:LLM_WIKI_VAULT) { $env:LLM_WIKI_VAULT } else { 'D:\DB\Obsidian\LLM-Wiki' })
)
$ErrorActionPreference = 'Stop'
$q = [char]34
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$Home2 = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $Home2 '.dsh' }
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $ProfileName
$Bin = Join-Path $DshHome 'bin'
$LogDir = Join-Path $DshHome 'llm-wiki'
$Reports = if ($env:LLM_WIKI_REPORTS) { $env:LLM_WIKI_REPORTS } else { 'D:\DB\DSH\reports' }
$Scripts = @('llm-wiki-pipeline.mjs','wiki-retrieval.mjs','wiki-router.mjs','profile-extract.mjs','profile-distill.mjs','session-compile-candidates.mjs','stale-review.mjs','pipeline-health.mjs','embed-proxy.mjs')
$Wrappers = @('llm-wiki-cron.cmd','profile-distill-cron.cmd','compile-candidates.cmd','stale-review.cmd')
$T1 = $TaskPrefix + 'LLM-Wiki Pipeline'
$T2 = $TaskPrefix + 'Profile Distill'
$T3 = $TaskPrefix + 'LLM-Wiki Compile Candidates'
$T4 = $TaskPrefix + 'LLM-Wiki Stale Review'
$Tasks = @($T1,$T2,$T3,$T4)
function Remove-IfExists($path) { if (Test-Path $path) { Remove-Item $path -Recurse -Force } }
if ($Uninstall) {
  Write-Host '==> Uninstalling dsh-llm-wiki'
  Remove-IfExists (Join-Path $ProfileDir 'dsh-llm-wiki.mjs')
  Remove-IfExists (Join-Path $Home2 '.agents\skills\wiki-search')
  Remove-IfExists (Join-Path $Home2 '.agents\skills\wiki-write')
  foreach ($s in $Scripts) { Remove-IfExists (Join-Path $Bin $s) }
  foreach ($w in $Wrappers) { Remove-IfExists (Join-Path $Bin $w) }
  foreach ($t in $Tasks) { schtasks /Delete /TN $t /F 2>$null | Out-Null }
  Write-Host ('    Files removed. Remove the llm-wiki insert from ' + $ProfileDir + '\cordis.patch.yml manually.')
  exit 0
}
Write-Host ('==> 1/4 plugin -> ' + $ProfileDir)
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Copy-Item (Join-Path $Repo 'plugin\dsh-llm-wiki.mjs') (Join-Path $ProfileDir 'dsh-llm-wiki.mjs') -Force
$Patch = Join-Path $ProfileDir 'cordis.patch.yml'
if ((Test-Path $Patch) -and (Select-String -Path $Patch -Pattern 'id: llm-wiki' -Quiet)) {
  Write-Host '    cordis.patch.yml already has llm-wiki, skipped'
} else {
  if (Test-Path $Patch) { $bak = $Patch + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'); Copy-Item $Patch $bak -Force; Write-Host ('    backup: ' + $bak) }
  $vaultYaml = $Vault -replace '\\', '/'
  $insert = [Environment]::NewLine + '# dsh-llm-wiki (LLM-Wiki lifecycle plugin)' + [Environment]::NewLine + '- insert:' + [Environment]::NewLine + '    - id: llm-wiki' + [Environment]::NewLine + '      name: ./dsh-llm-wiki.mjs' + [Environment]::NewLine + '      config:' + [Environment]::NewLine + '        vault: ' + $vaultYaml
  Add-Content -Path $Patch -Value $insert -Encoding utf8
  Write-Host '    appended insert to cordis.patch.yml (restart DSH to load)'
}
Write-Host ('==> 2/4 skills -> ' + $Home2 + '\.agents\skills')
foreach ($s in @('wiki-search','wiki-write')) { New-Item -ItemType Directory -Force -Path (Join-Path $Home2 ('.agents\skills\' + $s)) | Out-Null; Copy-Item (Join-Path $Repo ('skills\' + $s + '\SKILL.md')) (Join-Path $Home2 ('.agents\skills\' + $s + '\SKILL.md')) -Force }
Write-Host ('==> 3/4 scripts -> ' + $Bin)
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
foreach ($s in $Scripts) { Copy-Item (Join-Path $Repo ('scripts\' + $s)) (Join-Path $Bin $s) -Force }
if (-not $NoSchedule) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Host '    node not found in PATH; skipped scheduled tasks'; exit 0 }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  function New-Wrapper($name, $cmds) {
    $log = Join-Path $LogDir ($name + '.log')
    $lines = @('@echo off', ('echo [%DATE% %TIME%] start >> ' + $q + $log + $q))
    foreach ($c in $cmds) { $lines += ($c + ' >> ' + $q + $log + $q + ' 2>&1') }
    $lines += ('echo [%DATE% %TIME%] exit=%ERRORLEVEL% >> ' + $q + $log + $q)
    $path = Join-Path $Bin ($name + '.cmd')
    Set-Content -Path $path -Value $lines -Encoding ascii
    return $path
  }
  $pipelineCmd = $q + $node + $q + ' ' + $q + (Join-Path $Bin 'llm-wiki-pipeline.mjs') + $q + ' --all'
  $healthCmd = $q + $node + $q + ' ' + $q + (Join-Path $Bin 'pipeline-health.mjs') + $q
  $w1 = New-Wrapper 'llm-wiki-cron' @($pipelineCmd, $healthCmd)
  schtasks /Create /TN $T1 /TR ($q + $w1 + $q) /SC DAILY /ST 10:00 /F | Out-Null
  $w2 = New-Wrapper 'profile-distill-cron' @($q + $node + $q + ' ' + $q + (Join-Path $Bin 'profile-distill.mjs') + $q + ' --since 7d --out ' + $q + $Reports + $q)
  schtasks /Create /TN $T2 /TR ($q + $w2 + $q) /SC WEEKLY /D SUN /ST 09:00 /F | Out-Null
  $w3 = New-Wrapper 'compile-candidates' @($q + $node + $q + ' ' + $q + (Join-Path $Bin 'session-compile-candidates.mjs') + $q + ' --out ' + $q + $Reports + $q)
  schtasks /Create /TN $T3 /TR ($q + $w3 + $q) /SC WEEKLY /D SUN /ST 09:20 /F | Out-Null
  $w4 = New-Wrapper 'stale-review' @($q + $node + $q + ' ' + $q + (Join-Path $Bin 'stale-review.mjs') + $q + ' --limit 20 --out ' + $q + $Reports + $q)
  schtasks /Create /TN $T4 /TR ($q + $w4 + $q) /SC WEEKLY /D SUN /ST 09:40 /F | Out-Null
  Write-Host '    4 tasks created (Pipeline 10:00, Profile Sun 09:00, Compile Sun 09:20, Stale Sun 09:40)'
}
Write-Host ''
Write-Host 'Done.'
Write-Host ('  vault: ' + $Vault)
Write-Host ('  first run: node ' + (Join-Path $Bin 'llm-wiki-pipeline.mjs') + ' --all')
Write-Host ('  health:    node ' + (Join-Path $Bin 'pipeline-health.mjs'))
Write-Host '  restart DSH so the plugin loads'
