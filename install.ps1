# dsh-llm-wiki installer for DSH Desktop on Windows.
# Usage:
#   .\install.ps1                 # install plugin, skills, pipeline, daily task
#   .\install.ps1 -NoSchedule     # skip the daily scheduled task
#   .\install.ps1 -Uninstall      # remove installed files/task (patch is left untouched)
param(
  [switch]$NoSchedule,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$Repo  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Home2 = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $Home2 ".dsh" }
$ProfileDir = Join-Path $DshHome "profiles\desktop"
$Vault = if ($env:LLM_WIKI_VAULT) { $env:LLM_WIKI_VAULT } else { "D:\DB\Obsidian\LLM-Wiki" }
$TaskName = "LLM-Wiki Pipeline"

function Remove-IfExists($path) { if (Test-Path $path) { Remove-Item $path -Recurse -Force } }

if ($Uninstall) {
  Write-Host "==> Uninstalling dsh-llm-wiki"
  Remove-IfExists (Join-Path $ProfileDir "dsh-llm-wiki.mjs")
  Remove-IfExists (Join-Path $Home2 ".agents\skills\wiki-search")
  Remove-IfExists (Join-Path $Home2 ".agents\skills\wiki-write")
  Remove-IfExists (Join-Path $DshHome "bin\llm-wiki-pipeline.mjs")
  Remove-IfExists (Join-Path $DshHome "bin\embed-proxy.mjs")
  schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
  Write-Host "    Files removed. Remove the llm-wiki insert from $ProfileDir\cordis.patch.yml manually."
  exit 0
}

Write-Host "==> 1/4 plugin -> $ProfileDir"
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
Copy-Item (Join-Path $Repo "plugin\dsh-llm-wiki.mjs") (Join-Path $ProfileDir "dsh-llm-wiki.mjs") -Force
$Patch = Join-Path $ProfileDir "cordis.patch.yml"
if ((Test-Path $Patch) -and (Select-String -Path $Patch -Pattern "id: llm-wiki" -Quiet)) {
  Write-Host "    cordis.patch.yml already has llm-wiki, skipped"
} else {
  if (Test-Path $Patch) {
    $bak = "$Patch.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Copy-Item $Patch $bak -Force
    Write-Host "    backup: $bak"
  }
  $vaultYaml = $Vault -replace "\\", "/"
  $insert = "`n# dsh-llm-wiki (LLM-Wiki lifecycle plugin)`n- insert:`n    - id: llm-wiki`n      name: ./dsh-llm-wiki.mjs`n      config:`n        vault: $vaultYaml`n"
  Add-Content -Path $Patch -Value $insert -Encoding utf8
  Write-Host "    appended insert to cordis.patch.yml (restart DSH to load)"
}

Write-Host "==> 2/4 skills -> $Home2\.agents\skills"
New-Item -ItemType Directory -Force -Path (Join-Path $Home2 ".agents\skills\wiki-search") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Home2 ".agents\skills\wiki-write") | Out-Null
Copy-Item (Join-Path $Repo "skills\wiki-search\SKILL.md") (Join-Path $Home2 ".agents\skills\wiki-search\SKILL.md") -Force
Copy-Item (Join-Path $Repo "skills\wiki-write\SKILL.md")  (Join-Path $Home2 ".agents\skills\wiki-write\SKILL.md") -Force

Write-Host "==> 3/4 scripts -> $DshHome\bin"
New-Item -ItemType Directory -Force -Path (Join-Path $DshHome "bin") | Out-Null
Copy-Item (Join-Path $Repo "scripts\llm-wiki-pipeline.mjs") (Join-Path $DshHome "bin\llm-wiki-pipeline.mjs") -Force
Copy-Item (Join-Path $Repo "scripts\embed-proxy.mjs")       (Join-Path $DshHome "bin\embed-proxy.mjs") -Force

Write-Host "==> 4/4 daily task (10:00)"
if (-not $NoSchedule) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($node) {
    $pipeline = Join-Path $DshHome "bin\llm-wiki-pipeline.mjs"
    # 用 .cmd 包装把输出写进 cron.log：计划任务失败时可回溯（2026-10-22 曾出现一次 0xC000013A 无线索）
    $wrapper = Join-Path $DshHome "bin\llm-wiki-cron.cmd"
    $logDir = Join-Path $DshHome "llm-wiki"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $log = Join-Path $logDir "cron.log"
    $lines = @(
      "@echo off",
      "if not exist ""$logDir"" mkdir ""$logDir""",
      "echo [%DATE% %TIME%] start >> ""$log""",
      """" + $node + """ """ + $pipeline + """ --all >> ""$log"" 2>&1",
      "echo [%DATE% %TIME%] exit=%ERRORLEVEL% >> ""$log"""
    )
    Set-Content -Path $wrapper -Value $lines -Encoding ascii
    schtasks /Create /TN $TaskName /TR ('"' + $wrapper + '"') /SC DAILY /ST 10:00 /F | Out-Null
    Write-Host "    scheduled task created (10:00 daily, logs -> $log)"
  } else {
    Write-Host "    node not found in PATH; skipped scheduled task"
  }
}

Write-Host ""
Write-Host "Done."
Write-Host "  vault: $Vault"
Write-Host "  first run: node $DshHome\bin\llm-wiki-pipeline.mjs --all"
Write-Host "  restart DSH Desktop so the plugin loads"
