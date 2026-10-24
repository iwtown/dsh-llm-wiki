# Changelog

## 0.10.4 — 2026-10-24

- 修复：候选槽位在证据多数为 unclassified 时不回退计算，导致已落槽规则显示 unclassified。
- 过滤动作叙述型噪声（否定/指出/要求/说明…），不再当作规则候选。
- 评测新增 noise-narrative 用例（13 用例）。

## 0.10.3 — 2026-10-24

- 新增 eval-retrieval.mjs：6 条 fixture 查询跑 BM25 检索，检查 top-3 命中，无网络/无 mnemon。
- GitHub Actions 增加检索评测步骤，强制 100%。
- release.ps1 改为双门禁：画像决策 12/12 + 检索 6/6。
- README 组件表补充检索评测。

## 0.10.2 — 2026-10-24

- 画像决策评测从 8 扩到 **12 用例**：更新变体、unclassified、ORPHAN、单会话阈值。
- 修复 NOOP 过宽：新增“新条件”识别（审核/之后/至少/必须…），带条件的细化不再被判覆盖。
- README 增加 CI badge。

## 0.10.1 — 2026-10-24

- 新增 GitHub Actions `eval-profile`：push/PR 自动跑语法检查 + 8 用例决策评测，强制 100%。
- `release.ps1` 增加本地门禁：eval 未 100% 直接拒绝发版。
- RELEASE.md 增加 CI 门禁检查项。

## 0.10.0 — 2026-10-24

### 新增
- 画像结构化本体 profile-schema.json（6 域 × 2 = 12 槽，含允许值/正反例/更新规则/关键词）。
- 抽取端落槽 + 引文保真校验：quote 必须是用户原话子串，否则丢弃（实测 17.5%）。
- 决策标签 ADD/UPDATE/NOOP/CONFLICT/EXPIRE/ORPHAN；冲突分 temporal/factual/contextual，支持反义词对识别。
- 决策引擎评测 eval-profile.mjs：8 个隔离用例（时间更新/冲突/覆盖/弃权/过期/槽位），当前 8/8。
- 安装脚本同步 profile-schema.json 到 bin。

### 修复
- NOOP 过宽导致真更新被误杀（同槽同对象即判覆盖）。
- 反义冲突（免费 vs 付费）被误判为 UPDATE。
- 旧正则路径候选缺 decision 字段。

## 0.9.2 — 2026-10-24

- 新增 `RELEASE.md` 发布清单与 `scripts/release.ps1`：校验版本/工作树/语法/密钥，打 tag、推送、用 CHANGELOG 段落创建 GitHub Release，并校验 latest。
- 修正此前「tag 已推、Releases 仍停在 v0.2.0」的发布缺口（v0.9.0 / v0.9.1 的 Release 已补建）。

## 0.9.1 — 2026-10-24

- 新增异常告警：健康快照判定异常写 `reports/health/ALERT.md`，任务失败/告警时弹窗；正常时自动消警。
- 新增周报：`weekly-summary.mjs`，周日 09:50 生成 `reports/weekly/weekly-<date>.md` 与 `LATEST.md`。
- 安装脚本增加第 5 个任务与告警包装；`pipeline-health.mjs` 路径全部可用环境变量覆盖（无个人路径）。

## 0.9.0 — 2026-10-24

### 新增
- 检索路由 `wiki-router.mjs`（wiki/session/live/docs/hot 五路分流）与融合检索 `wiki-retrieval.mjs`（BM25 + mnemon RRF）。
- 画像 v3：`profile-extract.mjs`（3 角度抽取 + 行为事件）→ `profile-distill.mjs`（证据复核、预算分层、候选/diff）。
- 自动化三件套：`session-compile-candidates.mjs`（编译候选）、`stale-review.mjs`（保鲜复核）、`pipeline-health.mjs`（健康 CSV + 月报 + 探针）。
- 插件：大会话结束写编译提示标记，下一轮注入一次提示。
- 同步分级：`发现` 仅排除会话复盘/批量导入，排错/验证/其他纳入；`LLM_WIKI_SYNC_DISCOVERY` 可切换。
- Windows 安装脚本新增 9 个脚本与 4 个计划任务；管线日志与健康快照纳入每日任务。

### 修复
- `--compile-patterns` 跳过 archived 页；`--prune-memory` 只清理 import 且忽略 #小节；切块上限 24。

## 0.8.0 — 2026-10-22

- DSH 桌面版适配：zstd 多帧解压、`mnemon.exe` 解析、embedding 注入、Windows 计划任务。
- 偏好蒸馏 P0（只读）与周日 09:00 任务；OKF v0.2 字段补齐。
