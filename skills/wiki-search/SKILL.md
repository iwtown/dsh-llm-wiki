---
name: wiki-search
description: 在 LLM-Wiki 知识库（D:\\DB\\Obsidian\\LLM-Wiki）中检索知识。当用户问"之前怎么做的、以前的决策、踩坑经验、某主题的知识"或明确提到 LLM-Wiki/知识库/wiki 时使用。入口：grep 关键词搜索 → read 精读原文 → 引用页面路径。
---

# LLM-Wiki 知识检索

> LLM-Wiki 是 Karpathy 模式的 Obsidian 知识库（800+ 页，管线自动编译）。检索纪律：**先搜索、后精读、引用原文路径，禁止凭记忆编造知识库内容**。

## 库结构（12 分类，根：`D:\DB\Obsidian\LLM-Wiki\wiki\`）

| 分类 | 目录 | 内容 |
|---|---|---|
| 决策 | wiki/决策/ | ADR、架构选型、决策记录 |
| 发现 | wiki/发现/ | 会话复盘、踩坑经验、性能优化 |
| 引用 | wiki/引用/ | 网页剪藏（原文链接+摘要） |
| 概念 | wiki/概念/ | 领域概念（LLM-Wiki理念 等） |
| 项目 | wiki/项目/ | 项目知识页 |
| 流程/命令/规则/提示/记忆 | 对应目录 | 工作流、常用命令、红线、提示词、日志 |

## 默认流程

1. **导航优先**：先读 `wiki/index.md`（管线生成的导航页，含分类计数与最近更新）；已知分类时直接看该分类目录，比全文搜索快。
2. **关键词搜索**：用 DSH 的 `grep` 工具（自带 ripgrep，**不依赖 PATH 上的 rg**）：
   - `grep({ pattern: "关键词", path: "D:\\DB\\Obsidian\\LLM-Wiki\\wiki", include: "*.md" })`
   - 中文关键词直接搜；多主题用 `A|B`；需要排除 `_archived` / `trash` 时缩小 `path` 到具体分类目录。
   - 命令行等价物（本机装了 ripgrep 时）：`rg -l "关键词" wiki/ --glob "*.md"`。
3. **精读原文**：命中后 `read` 目标文件。**先读 frontmatter 预判**（前 20 行）：`type`、`description`、`related`、`stale_after`/`status`——不相关或已过时（当前日期 > stale_after 或 status: stale）直接跳过，相关再全文精读。
4. **行级定位**：grep 结果已带行号；需要上下文时用 `read` 的 `offset` 精读该段。
5. **引用**：回答时给出 wiki 页面相对路径（如 `wiki/决策/子代理模型选型与分配.md`）；溯源优先用 frontmatter 的 `sources` 字段（OKF v0.2：对象数组，每项含 `resource`），缺失时回退正文原始链接。

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
