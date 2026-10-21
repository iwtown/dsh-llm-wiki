# dsh-llm-wiki

> Karpathy LLM Wiki 模式的 DeepSeek Harness 知识库系统：模型写 wiki、管线维护、记忆体召回、质量闭环。
> 对齐 [Google Research WikiSkill](https://arxiv.org/abs/2608.27454) 三层架构 + [OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format) 知识格式规范。

基于 [Karpathy 的 LLM Wiki 理念](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 的 Obsidian 知识库自动化方案。整套系统由 **1 个极简插件 + 2 个技能 + 1 个管线脚本 + 1 个向量代理服务** 组成，刻意保持低代码、零第三方插件依赖。

## 架构

```
写：wiki-write SKILL → 模型会话内写 Obsidian wiki 页面（frontmatter/wikilink 规范）
管：llm-wiki-pipeline.mjs（lint/okf/compile-patterns/索引/记忆体同步/usage/rate，零依赖，幂等）
     ├─ systemd timer 每日 10:00 自动运行
     └─ 插件 session/disposed 事件触发（60s 防重入）
记：mnemon 记忆体（向量语义召回）
读：wiki-search SKILL（rg + read 检索原文）
馈：--rate 质量反馈 / --usage 召回热度回写 queried_count
编：--compile-patterns 从孤立节点聚类生成 pattern 页（WikiSkill 核心创新）
向：embed-proxy.mjs（Ollama 兼容代理 → SiliconFlow /v1/embeddings，可选）
```

| 组件 | 文件 | 部署位置 |
|---|---|---|
| 生命周期插件 | plugin/dsh-llm-wiki.mjs | `$DSH_HOME/profiles/<profile>/`（cordis.patch.yml 挂载；桌面版为 desktop） |
| 检索技能 | skills/wiki-search/SKILL.md | `~/.agents/skills/wiki-search/` |
| 写入技能 | skills/wiki-write/SKILL.md | `~/.agents/skills/wiki-write/` |
| 管线 | scripts/llm-wiki-pipeline.mjs | `$DSH_HOME/bin/`（WSL 旧布局为 `~/bin/`） |
| 向量代理（可选，旧方案） | scripts/embed-proxy.mjs | 仅当 embedding 端点只认 Ollama 协议时需要；mnemon 0.5+ 直连 OpenAI 兼容端点时不需要 |
| 定时（Linux） | systemd/llm-wiki-pipeline.timer | `~/.config/systemd/user/`；Windows 用 `install.ps1` 建计划任务 |

## 依赖

- dsh >= 0.2.0-rc.1（web 或 desktop profile；0.1.7 亦可）
- Node.js >= 22.15（管线用 `node:sqlite` 与 `zlib.zstdDecompressSync`；DSH 内置 24.x 满足）
- ripgrep（可选：DSH 的 `grep` 工具自带 ripgrep；只有命令行检索才需要 PATH 上的 `rg`）
- mnemon CLI + dsh-mnemon 插件（记忆体）
- Obsidian vault（wiki 页面），目录结构见 [wiki 结构](#wiki-结构)
- SiliconFlow API key（可选，用于向量召回；复用 ~/.modlens/config.json 或环境变量 EMBED_KEY）

## 安装

**方式 A：bundle 包（推荐，含插件）**

```bash
dsh plugin --profile web add github:iwtown/dsh-llm-wiki
```

然后安装 SKILL / 管线 / systemd 服务（install.sh 只做这一步也行）：

```bash
git clone https://github.com/iwtown/dsh-llm-wiki.git
cd dsh-llm-wiki && ./install.sh
systemctl --user restart dsh-web   # 让插件生效
```

**方式 B：install.sh 全量本地部署**（插件为 profile 本地文件，零 npm/零 node_modules，最反脆弱）

```bash
git clone https://github.com/iwtown/dsh-llm-wiki.git
cd dsh-llm-wiki && ./install.sh
systemctl --user restart dsh-web
```

`install.sh` 会把各组件复制到标准位置并启用 systemd 服务。然后：

1. **配置 vault 路径**：Linux/WSL 默认 `/mnt/d/DB/Obsidian/LLM-Wiki`，Windows 默认 `D:\DB\Obsidian\LLM-Wiki`（管线可用 `LLM_WIKI_VAULT` 覆盖；插件在 cordis.patch.yml 的 `config.vault` 覆盖；**SKILL 文件中的路径需按本机修改**）
2. **首次记忆体同步**：`node $DSH_HOME/bin/llm-wiki-pipeline.mjs --sync`（WSL 为 `~/bin/`；把 wiki 精华导入 mnemon）
3. **可选向量**：mnemon 0.5+ 可直接用 OpenAI 兼容端点（endpoint 以 `/v1` 结尾）；只有端点只认 Ollama 协议时才需要 embed-proxy

### Windows / DSH 桌面版

DSH 桌面版（profile `desktop`）在 Windows 上没有 systemd、没有 `~/bin`，且 Node 由应用内置。用 PowerShell 安装：

```powershell
git clone https://github.com/iwtown/dsh-llm-wiki.git
cd dsh-llm-wiki
.\install.ps1                 # 插件 + 技能 + 管线 + 每日 10:00 计划任务
# .\install.ps1 -NoSchedule   # 不建计划任务
# .\install.ps1 -Uninstall    # 卸载（patch 里的 insert 需手动删）
```

安装后的位置：

| 组件 | Windows 位置 |
|---|---|
| 插件 | `$env:USERPROFILE\.dsh\profiles\desktop\dsh-llm-wiki.mjs` |
| 技能 | `$env:USERPROFILE\.agents\skills\wiki-search\`、`wiki-write\` |
| 管线 | `$env:USERPROFILE\.dsh\bin\llm-wiki-pipeline.mjs` |
| 定时 | 计划任务 `LLM-Wiki Pipeline`（10:00 每日） |

桌面版适配要点（0.8.0）：

- **会话导出**：DSH 0.2.x 写作 `session.v4.jsonl.zstd`（版本号会变），管线按前缀匹配并用 `node:zlib` 逐帧解压，不再依赖 `zstd` 命令。
- **记忆体同步**：Windows 上 `mnemon` 是 `.cmd`，直接用 `execFile` 会 ENOENT/EINVAL；管线会优先找 npm 全局包里的 `mnemon.exe`，找不到再退回 `shell: true`。
- **embedding**：管线把 `MNEMON_EMBED_*` 注入 mnemon 子进程（endpoint/model/protocol/apiKey），key 依次读 `MNEMON_EMBED_API_KEY`、`EMBED_KEY`、`~/.dsh/.credentials.yaml` 的 `SF_API_KEY`、旧的 `~/.modlens/config.json`。
- **检索**：SKILL 改用 DSH 的 `grep` 工具（自带 ripgrep），不要求 PATH 上有 `rg`。
- **插件**：管线位置由 `$DSH_HOME` 推导；`session/disposed` 触发 `--all` 时会把 `LLM_WIKI_VAULT` 传给子进程。

## 使用

- **写入知识**：直接说"把这个记到知识库"，模型按 wiki-write 技能写入对应分类
- **检索知识**：问"之前怎么做的"，模型按 wiki-search 技能检索并引用原文
- **手动管线**：`node ~/bin/llm-wiki-pipeline.mjs --all`
- **质量反馈**：`node ~/bin/llm-wiki-pipeline.mjs --rate wiki/决策/xxx.md --rating useful|outdated`

### 管线路由

```bash
node ~/bin/llm-wiki-pipeline.mjs --lint          # frontmatter 完整性 + 孤立节点检测 + stale 报告
node ~/bin/llm-wiki-pipeline.mjs --okf           # OKF v0.2 字段补齐（幂等，verified 自动标记）
node ~/bin/llm-wiki-pipeline.mjs --compile-patterns  # 从孤立节点聚类生成 pattern 页
node ~/bin/llm-wiki-pipeline.mjs --index         # 重建导航页
node ~/bin/llm-wiki-pipeline.mjs --sync          # 变更同步到 mnemon 记忆体
node ~/bin/llm-wiki-pipeline.mjs --usage         # 回写召回热度到 frontmatter
node ~/bin/llm-wiki-pipeline.mjs --dsh-export    # 导出 DSH 会话到 raw/sessions/dsh/
node ~/bin/llm-wiki-pipeline.mjs --all           # 全量执行（含 --prune-memory）
node ~/bin/llm-wiki-pipeline.mjs --all --dry-run # 预览模式（零写入）
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| LLM_WIKI_VAULT | /mnt/d/DB/Obsidian/LLM-Wiki | vault 路径 |
| LLM_WIKI_STATE | ~/.dsh/llm-wiki/pipeline-state.json | 管线增量状态文件 |
| EMBED_KEY | 读 ~/.modlens/config.json | SiliconFlow API key |
| EMBED_MODEL | BAAI/bge-m3 | 向量模型 |

## wiki 结构

```
LLM-Wiki/
├── schema.md                # 运行时守则（插件注入到系统提示）
├── log.md                   # 操作日志（管线追加）
├── raw/                     # [Raw Layer] 原始素材（追加写入，永不删除）
│   ├── sessions/dsh/        # DSH 会话导出（管线 --dsh-export 自动生成）
│   └── zinbox-index/        # ZInBox 剪藏原始源
├── wiki/                    # [Wiki Layer] 编译后的结构化知识
│   ├── index.md             # 导航页（管线 --index 自动生成）
│   ├── evolution/
│   │   ├── logs.md          # 编译日志（pattern 创建/合并/归档事件）
│   │   └── skill-impact.md  # 技能影响追踪表
│   ├── patterns/            # WikiSkill 模式页（管线 --compile-patterns 自动生成）
│   │   ├── TEMPLATE.md      # Pattern 页模板
│   │   └── *-pattern.md     # 自动生成的可复用经验页
│   └── <12 分类>/           # 发现/决策/概念/流程/命令/规则/提示/记忆/项目/引用/索引/基因
└── skills/                  # [Skills Layer] 可执行技能追溯（扩展点）
    └── _template/PURPOSE.md # Skill 回溯到 inspire 它的 pattern 页
```

### OKF v0.2 字段

| 字段 | 类型 | 写入方 | 说明 |
|---|---|---|---|
| `sources` | `object[]`（每项 `resource` 必填） | 模型填写；管线 okfAlign 补全/规范化 | 知识来源（URL / session / 配置路径）；历史字符串数组会被 `--okf` 自动转成 `{ resource: ... }` |
| `generated` | `{ by, at }` | 管线自动补充 | 生成者（`agent/dsh-llm-wiki` 或 `human:<id>`） |
| `verified` | `{ by, at }` | quality_score≥4 自动标记 / --rate 确认 | 信任分级：agent verified / human reviewed |
| `status` | `active\|draft\|archived` | 管线 stale 检测 + --rate 更新 | 生命周期状态 |
| `stale_after` | ISO 日期 | 管线 okfAlign 自动计算 | created/updated + 90 天 |
| `description` | `string` | 管线 okfAlign 从内容摘要推导 | 一句话知识描述 |
| `quality_score` | 1-5 | 管线 usage 回写 + --rate 更新 | 知识质量评分 |

> OKF 规范截至 2026-10-21 仍为 **v0.2**（SPEC.md 未更新）；0.8.0 起 `--okf` 会把历史 `sources` 字符串数组规范化为 `{ resource: ... }` 对象，幂等。

### 信任分级

| 级别 | 条件 | 置信度 |
|---|---|---|
| ✅ human-reviewed | `verified.by` 含 `human:` | 高置信，优先召回 |
| ⚙️ machine-confirmed | `quality_score ≥ 4` 且无 human verified | 中置信，管线自动验证 |
| ⚠️ unverified | 新页面或 `quality_score < 3` | 低置信，需人工确认 |

## WikiSkill 三层架构对齐

| WikiSkill 层 | dsh-llm-wiki 对应 | 说明 |
|---|---|---|
| **Raw Layer** | `raw/sessions/`, `raw/zinbox-index/` | 原始素材；管线 `--dsh-export` 自动导入 |
| **Wiki Layer** | `wiki/`（12 分类 + patterns/ + evolution/） | 结构化知识；管线 `--lint/--okf/--compile-patterns` 自动维护 |
| **Skills Layer** | `skills/` + DSH `~/.agents/skills/` | 可执行技能；每个 skill 可选配 `PURPOSE.md` 回溯 pattern |

核心创新：**Pattern 层** — 从孤立节点聚类提取可复用经验，由管线 `--compile-patterns` 自动生成，写入 `wiki/evolution/logs.md` 编译日志。

## 设计原则

- **反脆弱**：检索/写入用 SKILL + DSH 原生工具（零插件故障面）；只有"必须进程内"的注入与事件钩子才进插件（~90 行）
- **幂等**：管线 mtime 增量检测，重复运行无副作用；`--okf` / `--compile-patterns` 均幂等
- **闭环**：使用数据（recall 命中）→ queried_count → quality_score → 影响召回 → verified 信任分级
- **本地优先**：wiki 与记忆体全本地，向量可选云端
- **编译进化**：孤立节点 → pattern 聚类 → 可复用经验，知识随使用不断提炼

## License

MIT
