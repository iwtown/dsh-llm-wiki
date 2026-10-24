---
name: wiki-search
description: 在 LLM-Wiki 知识库（D:\\DB\\Obsidian\\LLM-Wiki）中检索知识。当用户问"之前怎么做的、以前的决策、踩坑经验、某主题的知识"或明确提到 LLM-Wiki/知识库/wiki 时使用。入口：grep 关键词搜索 → read 精读原文 → 引用页面路径。
---

# LLM-Wiki 知识检索

> LLM-Wiki 是 Karpathy 模式的 Obsidian 知识库（800+ 页，管线自动编译）。检索纪律：**先搜索、后精读、引用原文路径，禁止凭记忆编造知识库内容**。
>
> **检索路由**：当天/精确/排错 → 本技能（grep + read 原文）；跨天/联想/找经验 → `mnemon_recall`；项目档案 → `mnemon_document_search`。
> mnemon 按 H2 小节切块，命中形如 `[页面｜小节] …（来源: path#小节）`，按该路径回 wiki 精读对应小节。
> `status: archived` 的页面仍可 grep 到，但默认优先非 archived；它们不参与 mnemon 同步，回答时注明「已归档」。

## 库结构（11 分类，根：`D:\DB\Obsidian\LLM-Wiki\wiki\`）

| 分类 | 目录 | 内容 |
|---|---|---|
| 决策 | wiki/决策/ | ADR、架构选型、决策记录 |
| 发现 | wiki/发现/ | 会话复盘、踩坑经验、性能优化 |
| 引用 | wiki/引用/ | 网页剪藏（原文链接+摘要） |
| 概念 | wiki/概念/ | 领域概念（LLM-Wiki理念 等） |
| 项目 | wiki/项目/ | 项目知识页 |
| 流程/命令/规则/提示/记忆 | 对应目录 | 工作流、常用命令、红线、提示词、日志 |

## 默认流程

0. **先分流（新增，别跳）**：`node "$env:USERPROFILE\.dsh\bin\wiki-router.mjs" "<问题>"`
   - 输出 `wiki / session / live / docs / hot` 五类之一 + 置信度 + 下一步命令。session 路由的 `--exec` 返回 `sid + summary + score + why`，可直接判断"是不是这次会话"。**只有 wiki 路由才继续下面的检索流程**；`session` 走 `node "$env:USERPROFILE\.dsh\bin\wiki-router.mjs" "<问题>" --exec`（内含 embedding 语义会话检索，命中@3 约 70%），`live` 直接实测，`docs` 走 Documents，`hot` 看热记忆。
   - **级联规则**：wiki 检索返回的 top1 如果与问题明显不相干（或全部 < 相关阈值），不要再硬查 wiki，改用会话语义检索——真实的"上次怎么弄的"问题常常口语化到没有知识关键词。
   - 判据：出现「上次/装过/没拉起/报错/怎么办/安装/URL」→ session；「现在/是否/端口/进程/检查一下」→ live；「什么/区别/原理/怎么设计/哪些组件」→ wiki。
1. **融合检索（首选）**：`node "$env:USERPROFILE\.dsh\bin\wiki-retrieval.mjs" "<问题>" --limit 5`
   - BM25（全库）+ `mnemon recall` → RRF 融合 → 质量/新鲜度/stale 重排；输出「摘要 + 路径 + 双路排名」，据路径精读。
   - `--json` 取机器可读；`--no-mnemon` 只跑 BM25；`--limit N` 调条数。评测：命中@3 ≈73%（多次 70–80%；BM25 63% / recall 43–47%）。
   - **仅用于知识型提问**；"本机怎么装/怎么修/上次做到哪"这类运维问题应走会话历史与热记忆，别用本脚本硬查。
2. **导航优先**：先读 `wiki/index.md`（管线生成的导航页，含分类计数、热投影与最近更新）；已知分类时直接看该分类目录，比全文搜索快。
3. **关键词搜索**：用 DSH 的 `grep` 工具（自带 ripgrep，**不依赖 PATH 上的 rg**）：
   - `grep({ pattern: "关键词", path: "D:\\DB\\Obsidian\\LLM-Wiki\\wiki", include: "*.md" })`
   - 中文关键词直接搜；多主题用 `A|B`；需要排除 `_archived` / `trash` 时缩小 `path` 到具体分类目录。
   - 命令行等价物（本机装了 ripgrep 时）：`rg -l "关键词" wiki/ --glob "*.md"`。
4. **精读原文**：命中后 `read` 目标文件。**先读 frontmatter 预判**（前 20 行）：`type`、`description`、`related`、`stale_after`/`status`——不相关或已过时（当前日期 > stale_after 或 status: stale）直接跳过，相关再全文精读。
5. **行级定位**：grep 结果已带行号；需要上下文时用 `read` 的 `offset` 精读该段。
6. **引用**：回答时给出 wiki 页面相对路径（如 `wiki/决策/子代理模型选型与分配.md`）；溯源优先用 frontmatter 的 `sources` 字段（OKF v0.2：对象数组，每项含 `resource`），缺失时回退正文原始链接。

## 失败处理

| 场景 | 处理 |
|---|---|
| 搜索无命中 | 换关键词/同义词重试；仍无则明确说"知识库未收录" |
| 只有旧日志命中 | 用 `log.md` 按 `## [YYYY-MM-DD] compile` 找编译记录定位页面 |
| 用户问的是偏好/协作规则 | 优先查热记忆（MEMORY.md）而非 wiki |
| 深度语义（"之前聊过的 X"） | 用 `mnemon_recall`（记忆体召回） |
| 页面有用/已过时 | `node "$env:USERPROFILE\.dsh\bin\llm-wiki-pipeline.mjs" --rate <路径> --rating useful|outdated`（WSL 为 `~/bin/...`） |
| 命中页已过时 | 引用时标注可能过时，优先找新页面或按 sources 回原始来源核实 |

## 写入纪律（产出侧协作）

- 会话中学到新知识：按 vault 根 `schema.md` 守则写入对应分类（管线自动维护 frontmatter/关联/质量）。
- 写作规则：中文标题；每页 >=2 条 [[wikilinks]]；写入前先搜索避免重复；不硬编码密钥。
