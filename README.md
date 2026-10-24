# dsh-llm-wiki

[![eval-profile](https://github.com/iwtown/dsh-llm-wiki/actions/workflows/eval.yml/badge.svg)](https://github.com/iwtown/dsh-llm-wiki/actions/workflows/eval.yml)

> 让 Agent 拥有一个**会自己长大、也会自己变老**的知识库。
> Karpathy LLM Wiki 模式 × DeepSeek Harness：模型写页、管线维护、记忆体召回、质量闭环。

基于 [Karpathy 的 LLM Wiki 理念](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)，对齐 [Google Research WikiSkill](https://arxiv.org/abs/2608.27454) 三层架构与 [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) 知识格式。

---

## 它解决什么问题

- **Agent 会忘**：会话结束即失忆 → 把决策、排错、可复用结论编译成 wiki 页，形成持久证据。
- **旧答案反复出现**：没有保鲜机制 → stale 页面定期复核、降级、归档。
- **偏好要反复解释**：偏好散落在对话里 → 从会话抽取证据，蒸馏成 USER.md 规则（每轮注入）。

## 设计原则

1. **三层分工**：`raw/`（原始素材，永不删除）→ `wiki/`（模型维护的真相源）→ `schema.md`（写页/检索纪律）。
2. **低代码、零第三方依赖**：1 个插件 + 2 个技能 + 若干零依赖 Node 脚本；不引入向量库/数据库。
3. **只读优先**：蒸馏、stale 复核、编译候选都只产清单；写 USER.md / 归档页面必须经确认。
4. **可审计、可重建**：wiki 是 git 仓库；mnemon 索引可从 wiki 重建；每次自动化都写日志。

## 架构

```
写   wiki-write SKILL ──────────────► wiki/ 页面（frontmatter / wikilink / OKF v0.2）
管   llm-wiki-pipeline.mjs ─────────► lint / okf / index / sync / usage / compile-patterns
     ├─ 每日 10:00 计划任务            / docs-sync / dsh-export / prune / reconcile
     └─ 插件 session/disposed（增量）
记   mnemon（bge-m3 向量）◄────────── H2 块 + 语义边（可重建）
读   wiki-router.mjs → wiki-retrieval.mjs（BM25 + 向量融合 RRF）
     └─ session / live / docs / hot 四路分流
馈   --rate useful|outdated ────────► quality_score / queried_count
编   --compile-patterns ────────────► 孤立页聚类成 pattern 页
像   profile-extract → profile-distill ─► 候选 → USER.md（规则）/ 画像页（证据）
养   compile-candidates / stale-review / pipeline-health ─► 候选清单 / 复核清单 / 健康 CSV
```

## 组件

| 组件 | 文件 | 部署位置（Windows 桌面版） |
|---|---|---|
| 生命周期插件 | `plugin/dsh-llm-wiki.mjs` | `%USERPROFILE%\.dsh\profiles\desktop\` |
| 写入技能 | `skills/wiki-write/SKILL.md` | `%USERPROFILE%\.agents\skills\wiki-write\` |
| 检索技能 | `skills/wiki-search/SKILL.md` | `%USERPROFILE%\.agents\skills\wiki-search\` |
| 管线 | `scripts/llm-wiki-pipeline.mjs` | `%USERPROFILE%\.dsh\bin\` |
| 融合检索 | `scripts/wiki-retrieval.mjs` | 同上 |
| 查询路由 | `scripts/wiki-router.mjs` | 同上 |
| 画像抽取 | `scripts/profile-extract.mjs` | 同上 |
| 画像本体 | `scripts/profile-schema.json` | 同上（12 槽 = 6 域 × 2） |
| 决策评测 | `scripts/eval-profile.mjs` | 开发/CI 用，8 个隔离用例 |
| 画像蒸馏 | `scripts/profile-distill.mjs` | 同上 |
| 编译候选 | `scripts/session-compile-candidates.mjs` | 同上 |
| stale 复核 | `scripts/stale-review.mjs` | 同上 |
| 健康快照 | `scripts/pipeline-health.mjs` | 同上 |
| 向量代理（可选） | `scripts/embed-proxy.mjs` | 仅在 embedding 端点只认 Ollama 协议时需要 |
| 定时（Linux） | `systemd/*` | `~/.config/systemd/user/` |
| 安装脚本 | `install.sh` / `install.ps1` | 复制组件 + 建计划任务 |

## 安装

> **平台范围**：Windows 桌面版为优先支持路径（插件 + 技能 + 9 个脚本 + 5 个计划任务）。Linux/WSL 目前 `install.sh` 只覆盖插件、技能、管线与 systemd 的 pipeline timer；编译候选、stale 复核、健康快照三个周任务**未随仓库提供 systemd timer**，需要时自行加。

**方式 A：bundle（只装插件）**

```bash
dsh plugin --profile web add github:iwtown/dsh-llm-wiki
```

**方式 B：全量本地部署（推荐）**

```bash
git clone https://github.com/iwtown/dsh-llm-wiki.git
cd dsh-llm-wiki && ./install.sh          # Linux / WSL
# 或
.\install.ps1                             # Windows（-NoSchedule 跳过定时任务）
```

然后重启 `dsh web` 让插件生效，并首次全量同步：

```bash
node ~/.dsh/bin/llm-wiki-pipeline.mjs --all
node ~/.dsh/bin/pipeline-health.mjs       # 生成首份健康快照
```

### 计划任务（Windows）

| 任务 | 时间 | 作用 |
|---|---|---|
| LLM-Wiki Pipeline | 每日 10:00 | `--all` + 健康快照 |
| Profile Distill | 周日 09:00 | 画像候选 |
| LLM-Wiki Compile Candidates | 周日 09:20 | 未编译会话候选 |
| LLM-Wiki Stale Review | 周日 09:40 | stale Top20 复核清单 |
| LLM-Wiki Weekly Summary | 周日 09:50 | 周报（任务结果/健康变化/待办清单） |
| Mnemon Backup | 每日 10:30 | mnemon 快照（独立组件，不由本仓库安装） |

## 管线命令

| 命令 | 作用 |
|---|---|
| `--lint` | frontmatter / 双链 / 孤立 / stale / 断链（磁盘为准）/ 缺来源 |
| `--okf` | 补 OKF v0.2 字段（幂等） |
| `--index` | 重建导航与热投影 |
| `--sync` | wiki H2 块 → mnemon（哈希增量 + 语义边） |
| `--usage` | 回写召回热度 |
| `--compile-patterns` | 孤立页聚类成 pattern（证据门槛 3） |
| `--docs-sync` | mnemon Documents → wiki |
| `--dsh-export` | DSH 会话 → `raw/sessions/dsh/` |
| `--prune-memory` | 清理来源已消失的块 |
| `--reconcile` | 邻域调和报告（只读，可开 LLM） |
| `--rate <页> --rating useful\|outdated` | 质量反馈 |
| `--all` / `--all --dry-run` | 全量 / 预览 |

## 检索路由

```bash
node ~/.dsh/bin/wiki-router.mjs "上次怎么修 gnome 黑屏"   # 返回 route: wiki|session|live|docs|hot
node ~/.dsh/bin/wiki-retrieval.mjs "关键词" --limit 5 --json
```

融合策略：BM25 + mnemon 向量 RRF（K=5，权重 1.0/0.5，标题加权 4）。调参用 `LLM_WIKI_RRF_K / _WB / _WM / TITLE_BOOST / CAT_WEIGHT`。

## 画像蒸馏（v3：本体 + 决策 + 保真）

```bash
node ~/.dsh/bin/profile-extract.mjs --since 30d    # 3 角度抽取 + 行为事件
node ~/.dsh/bin/profile-distill.mjs --since 30d    # 复核 → 候选 → USER.md diff
```

- **规则进 USER.md**（每轮注入，≤2KB 目标），**证据留画像页**（`profile_scope: evidence`）与记忆空间；
- 12 槽本体（6 域 × 2），抽取必须落槽，落不到记 unclassified 交复核；
- 引文保真：quote 必须是用户原话子串（≥6 字），否则丢弃（实测约 17%）；
- 决策标签 ADD/UPDATE/NOOP/CONFLICT/EXPIRE；CONFLICT 带 temporal/factual/contextual 类型；
- 抽取免费（Z.ai GLM-4-Flash 优先），复核固定 DeepSeek 官网 `deepseek-flash`；
- 候选按「红线 3 / 沟通 2 / 工作 5 / 其他 2」配额，上限 12 条；
- 应用只经 `mnemon_runtime_memory`，并回写画像页演变记录；
- 自测：node scripts/eval-profile.mjs（8 用例：时间更新/冲突/覆盖/弃权/过期/槽位）。

## 自动化与健康

- **同步分级**：`引用` 默认不入库；`发现` 只排除会话复盘/批量导入，排错/验证类纳入（`LLM_WIKI_SYNC_DISCOVERY=recap-only|all|off`）。
- **编译触发**：会话日志 ≥300KB 时插件写提示标记，下一轮注入一次；`session-compile-candidates.mjs` 每周产出候选清单（只读）。
- **保鲜**：`stale-review.mjs` 每周 Top20，按「质量低 + 最久未更新 + 被引用多」排序，附可执行 `--rate` 命令。
- **健康**：`pipeline-health.mjs` 每日写 `reports/health/health-YYYY-MM.csv`，含 6 条召回探针；每月生成对比月报。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_WIKI_VAULT` | `/mnt/d/DB/Obsidian/LLM-Wiki` | vault 路径（Windows 默认 `D:\DB\Obsidian\LLM-Wiki`） |
| `LLM_WIKI_STATE` | `~/.dsh/llm-wiki/pipeline-state.json` | 增量状态 |
| `LLM_WIKI_SYNC_EXCLUDE` | `引用` | 不入库分类 |
| `LLM_WIKI_SYNC_DISCOVERY` | `recap-only` | 发现类分级 |
| `LLM_WIKI_CHUNK_MIN / MAX / PER_PAGE / BATCH` | `40 / 1200 / 24 / 40` | 切块参数 |
| `MNEMON_EMBED_*` / `EMBED_KEY` / `EMBED_MODEL` | 读 `~/.dsh/.credentials.yaml` 的 SF key | 向量 |
| `LLM_WIKI_LLM_MODELS` | `glm-4-flash-250414,glm-4.7-flash,THUDM/GLM-4-9B-0414` | 抽取链（免费） |
| `LLM_WIKI_REVIEW_MODELS` | `deepseek-flash` | 复核链（官网） |
| `LLM_WIKI_REVIEW_ENDPOINT` | `https://api.deepseek.com/v1` | 官网端点 |
| `LLM_WIKI_REPORTS` | `D:\DB\DSH\reports` | 候选/清单/健康/周报输出目录 |
| `PROFILE_MAX_ADD` | `12` | 单批候选上限 |
| `PROFILE_SCHEMA` | 同目录 profile-schema.json | 画像本体路径 |
| `PROFILE_REVIEW` | 开 | off 跳过复核（仅测试） |
| `LLM_WIKI_COMPILE_HINT` | 开 | 设 `off` 关闭会话编译提示 |
| `LLM_WIKI_RRF_K / _WB / _WM / TITLE_BOOST` | `5 / 1.0 / 0.5 / 4` | 融合检索调参 |

## 告警与周报

- 健康快照发现异常（同步页骤降 / stale 激增 / lint 激增 / 探针命中 <60%）时写 `reports/health/ALERT.md` 并返回码 2；任务包装据此弹窗。异常消失后自动消警。
- 周报：`reports/weekly/LATEST.md`（每周一页：任务结果、7 条健康变化、待处理清单）。

## 质量门槛

| 指标 | 目标 |
|---|---|
| 断链 | 0 |
| 同步覆盖（可入库页） | 100% |
| 会话编译率 | ≥70% |
| stale 处置 | 20 条/周 |
| 画像候选精度 / gold 覆盖 | ≥75% / ≥75% |
| 健康探针 hit@3 | 6/6 |

## 排错

- **Windows 上 mnemon 是 .cmd**：管线优先找 npm 全局包里的 `mnemon.exe`，找不到退回 `shell: true`。
- **会话日志是 zstd 多帧**：用 `zlib.zstdDecompressSync` 逐帧解，不依赖 zstd 命令。
- **LLM 429/1305**：免费模型高峰期限流，抽取链自动降级；复核固定官网模型不受影响。
- **代理**：默认不走代理；需要时只在单条命令显式指定，不要写进 DSH 环境或 git 配置。
- **mnemon 重建**：重跑 `--sync`；若整库重建，需重置远端同步分支。

## 仓库结构

```
dsh-llm-wiki/
├─ plugin/dsh-llm-wiki.mjs        # 注入 + 生命周期 + 编译提示
├─ scripts/
│  ├─ llm-wiki-pipeline.mjs       # 维护管线
│  ├─ wiki-retrieval.mjs          # 融合检索
│  ├─ wiki-router.mjs             # 五路分流
│  ├─ profile-extract.mjs         # 会话 → 证据
│  ├─ profile-distill.mjs         # 证据 → 候选
│  ├─ session-compile-candidates.mjs
│  ├─ stale-review.mjs
│  ├─ pipeline-health.mjs
│  └─ embed-proxy.mjs
├─ skills/wiki-write · skills/wiki-search
├─ systemd/  install.sh  install.ps1
├─ package.json（bundle 只含插件）
└─ CHANGELOG.md
```

## 版本

- `0.10.0`：画像本体（12 槽）+ 决策标签 + 引文保真 + 决策引擎评测 8/8；安装脚本同步 schema。
- `0.9.0`：检索路由 + 融合检索；画像 v3（证据管线/复核/预算）；编译候选、stale 复核、健康快照；发现分级同步；会话编译提示。
- `0.8.0`：DSH 桌面版适配（zstd、mnemon.exe、embedding 注入、Windows 任务）。

## 发布

发版流程见 [RELEASE.md](./RELEASE.md)：版本三处一致 → 自测 → commit/tag → push → `scripts/release.ps1` 创建 GitHub Release 并校验 latest。

## License

MIT
