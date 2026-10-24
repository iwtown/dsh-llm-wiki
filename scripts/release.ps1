param(
  [string]$Version = '',
  [string]$Proxy = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo
$pkg = [IO.File]::ReadAllText((Join-Path $Repo 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not $Version) { $Version = $pkg.version }
if ($pkg.version -ne $Version) { throw "package.json version ($($pkg.version)) != $Version" }
$check = @(git status --porcelain)
Write-Host ("==> version " + $Version)
Get-ChildItem 'scripts\*.mjs','plugin\*.mjs' | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { throw ('syntax error: ' + $_.Name) }
}
$errs = $null; $toks = $null
[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $Repo 'install.ps1'), [ref]$toks, [ref]$errs)
if ($errs.Count -gt 0) { throw ('install.ps1 parse error: ' + $errs[0].Message) }
$leak = Select-String -Path 'scripts\*.mjs','plugin\*.mjs','install.ps1','README.md' -Pattern 'sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|C:\\Users\\[A-Za-z0-9_.-]+' -ErrorAction SilentlyContinue
if ($leak) { throw ('secret/path leak: ' + ($leak | Select-Object -First 1).Path) }
$cl = [IO.File]::ReadAllText((Join-Path $Repo 'CHANGELOG.md'), [Text.Encoding]::UTF8)
$m = [regex]::Match($cl, '(?ms)^## ' + [regex]::Escape($Version) + ' [^\r\n]*\r?\n(.*?)(?=^## |\z)')
if (-not $m.Success) { throw ('CHANGELOG missing section for ' + $Version) }
$notes = $m.Groups[1].Value.Trim()
if ($DryRun) { Write-Host 'DRYRUN OK'; Write-Host ('notes: ' + $notes.Substring(0, [Math]::Min(80, $notes.Length))); return }
git add -A
git -c user.name=dsh -c user.email=dsh@local commit -m ('release: v' + $Version) --no-verify | Out-Null
git tag -f ('v' + $Version) | Out-Null
$gp = @()
if ($Proxy) { $gp = @('-c', ('http.proxy=' + $Proxy), '-c', ('https.proxy=' + $Proxy)) }
git @gp push origin main
git @gp push origin ('v' + $Version)
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
$tok = (($cred | Select-String '^password=').Line -replace '^password=', '').Trim()
if (-not $tok) { throw 'no GitHub token from git credential' }
$h = @{ 'User-Agent' = 'dsh-agent'; 'Authorization' = 'Bearer ' + $tok; 'Accept' = 'application/vnd.github+json' }
$payload = @{ tag_name = ('v' + $Version); name = ('v' + $Version); body = $notes; draft = $false; prerelease = $false } | ConvertTo-Json -Depth 4
$bodyBytes = [Text.Encoding]::UTF8.GetBytes($payload)
$rel = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/iwtown/dsh-llm-wiki/releases' -Headers $h -ContentType 'application/json; charset=utf-8' -Body $bodyBytes -TimeoutSec 40
$latest = Invoke-RestMethod -Uri 'https://api.github.com/repos/iwtown/dsh-llm-wiki/releases/latest' -Headers $h -TimeoutSec 30
if ($latest.tag_name -ne ('v' + $Version)) { throw ('latest release mismatch: ' + $latest.tag_name) }
Write-Host ('released ' + $Version + ' -> ' + $rel.html_url)
