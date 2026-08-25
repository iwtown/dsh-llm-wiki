---
name: wiki-search
description: 在 LLM-Wiki 知识库（/mnt/d/DB/Obsidian/LLM-Wiki）中检索知识。当用户问"之前怎么做的、以前的决策、踩坑经验、某主题的知识"或明确提到 LLM-Wiki/知识库/wiki 时使用。入口：rg 关键词搜索 → read 精读原文 → 引用页面路径。
---

# LLM-Wiki 知识检索

> LLM-Wiki 是 Karpathy 模式的 Obsidian 知识库（约 909 页，管线自动编译）。检索纪律：**先搜索、后精读、引用原文路径，禁止凭记忆编造知识库内容**。

## 库结构（12 分类，根：/mnt/d/DB/Obsidian/LLM-Wiki/wiki/）

| 分类 | 目录 | 内容 |
|---|---|---|
| 决策 | wiki/决策/ | ADR、架构选型、决策记录 |
| 发现 | wiki/发现/ | 会话复盘、踩坑经验、性能优化 |
| 引用 | wiki/引用/ | 网页剪藏（原文链接+摘要） |
| 概念 | wiki/概念/ | 领域概念（LLM-Wiki理念 等） |
| 项目 | wiki/项目/ | 项目知识页（Pi-Agent、gsd-v2 等） |
| 流程/命令/规则/提示/记忆 | 对应目录 | 工作流、常用命令、红线、提示词、日志 |

## 默认流程

1. **导航优先**：先读分类索引页 `wiki/索引/<分类>.md`（Dataview 聚合，列出该分类全部页面）——已知分类时直接读索引比搜索快。
2. **关键词搜索**：在 vault 根目录执行 `rg -l "<关键词>" wiki/ --glob "*.md"`。
   - 中文关键词直接搜；多主题用 `rg -l "A|B"`；排除 `_archived`、`trash` 目录。
   - 结果按目录顺序返回，模型自行判断相关度（标题通常即主题）。
3. **精读原文**：命中后 `read` 目标文件。带 frontmatter（title/related/quality_score 等）为编译页。
4. **行级定位**：需要定位时 `rg -n "<关键词>" <文件>` 获取行号与内容。
5. **引用**：回答时给出 wiki 页面相对路径（如 `wiki/决策/子代理模型选型与分配.md`）；引用剪藏页时给原始链接（frontmatter 的 source 或正文 Read Original 链接）。

## 失败处理

| 场景 | 处理 |
|---|---|
| 搜索无命中 | 换关键词/同义词重试；或用更短关键词 `rg -l`；仍无则明确说"知识库未收录" |
| 只有旧日志命中 | 用 `log.md` 按 `## [YYYY-MM-DD] compile` 找编译记录定位页面 |
| 用户问的是偏好/协作规则 | 优先查热记忆（MEMORY.md）而非 wiki |
| 深度语义（"之前聊过的 X"） | 用 mnemon_recall（记忆体召回） |
| 页面有用/已过时 | 用 `node ~/bin/llm-wiki-pipeline.mjs --rate <路径> --rating useful|outdated` 反馈（驱动 quality_score 闭环） |

## 写入纪律（产出侧协作）

- 会话中学到新知识：按 vault 根 `schema.md` 守则写入对应分类（管线自动维护 frontmatter/关联/质量）。
- 写作规则：中文标题；每页 >=2 条 [[wikilinks]]；写入前先搜索避免重复；不硬编码密钥。
