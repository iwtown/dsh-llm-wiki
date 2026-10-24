# 发布清单（Release Checklist）

> 每次发版按此顺序执行；**tag 与 GitHub Release 必须同时创建**，否则 Releases 页会停留在旧版本。

## 0. 前置

- [ ] 工作树干净（`git status --porcelain` 为空）
- [ ] 改动已完成自测（见下）
- [ ] 本地 alias / 环境有可用的 GitHub 凭据（`git credential fill` 能返回 password）

## 1. 版本号（三处一致）

- [ ] `package.json` → `version`
- [ ] `README.md` 末尾「版本」段
- [ ] `CHANGELOG.md` 新增 `## <version> — <date>` 段

## 2. 自测

- [ ] 语法：`node --check` 全部 `scripts/*.mjs` 与 `plugin/*.mjs`
- [ ] 安装器解析：PowerShell Parser 解析 `install.ps1` 无错误
- [ ] 冒烟：临时 vault 跑 `--lint` / `--index` / `--sync --dry-run` / `pipeline-health.mjs`
- [ ] 安装：隔离 HOME 跑 `install.ps1 -TaskPrefix TEST- -NoSchedule`，确认文件与 patch，再清理
- [ ] 安全：仓库内无 `sk-`、`ghp_`、`C:\Users\<user>` 命中

## 2.5 自动门禁（CI）

- [ ] GitHub Actions `eval` 为绿色（画像 12/12 + 检索 6/6）
- [ ] 本地 `scripts/release.ps1` 双门禁通过（画像 + 检索），未 100% 直接拒绝发布

## 3. 提交与打标

```powershell
git add -A
git commit -m "release: v<version> — <摘要>"
git tag -f v<version>
```

## 4. 推送（GitHub 直连不通时显式加代理）

```powershell
git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 push origin main
git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 push origin v<version>
```

## 5. 创建 GitHub Release（必做）

```powershell
.\scripts\release.ps1 -Version <version> -Proxy http://127.0.0.1:10808
```

脚本会：校验版本/工作树/语法/密钥 → 打 tag → 推送 → 用 CHANGELOG 对应段落作为 Release notes 创建 Release → 校验 `/releases/latest`。

## 6. 验收

- [ ] `releases/latest` 的 tag = 新版本
- [ ] Releases 页出现新条目（不是只有旧版本）
- [ ] tag 与 Release 指向同一 commit

## 回滚

- 删除错误 Release（GitHub 页面）→ `git tag -d v<version>` → `git push origin :refs/tags/v<version>`；
- 代码回滚用 `git revert`，不要 force push main。
