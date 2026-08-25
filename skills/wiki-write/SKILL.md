---
name: wiki-write
description: 向 LLM-Wiki 知识库（/mnt/d/DB/Obsidian/LLM-Wiki）写入新知识。当会话中学到新知识、做出决策、发现踩坑经验、用户要求记录/保存知识到 wiki 时使用。写入纪律：先查重、选对分类、frontmatter 完整、wikilink>=2、中文标题。
---

# LLM-Wiki 知识写入

> 生产端规范：模型在会话中直接写 wiki（Obsidian vault 就是磁盘上的 md 文件），管线脚本自动做 lint/索引/记忆体同步。写入纪律：**先查重、后写入、引用旧知识、不制造孤立节点**。

## 分类决策树（新知识进哪个分类）

| 知识类型 | 分类 | 目录 | 示例 |
|---|---|---|---|
| 架构选型/技术决策/明确取舍 | **决策** | wiki/决策/ | 子代理模型选型与分配；ADR 模板见 templates/t-ADR.md |
| 踩坑经验/性能优化/验证结果/修复记录 | **发现** | wiki/发现/ | pi-扩展安装经验；性能优化验证 |
| 领域概念/名词解释/理念 | **概念** | wiki/概念/ | LLM-Wiki理念；Pi扩展编写模式 |
| 项目知识/项目级决策 | **项目** | wiki/项目/ | 项目概览页（templates/t-项目概览.md） |
| 操作流程/工作流 | **流程** | wiki/流程/ | 知识编译；日常开发 |
| 常用命令/工具用法 | **命令** | wiki/命令/ | 常用命令 |
| 红线规则/安全约束 | **规则** | wiki/规则/ | ERPNext 操作红线 |
| 高质量提示词 | **提示** | wiki/提示/ | pi-agent-prompt-全集 |
| 网页剪藏/外部引用 | **引用** | wiki/引用/ | 只建摘要+链接，不复制全文 |
| 不确定 | **先问用户** | — | 不猜分类 |

## 写入流程（必须按序）

1. **查重**：先用 wiki-search SKILL 搜关键词——已有相同/相似页面则**更新它**，不新建（更新优先于新建，防止孤立节点）。
2. **定分类**：按决策树选分类；不确定时问用户。
3. **写文件**：路径 wiki/<分类>/<中文标题>.md；frontmatter 按下方模板。
4. **关联**：body 里 >=2 条 [[wikilinks]] 指向相关旧页面（related 字段也填）；用 rg -l 找可关联的旧页。
5. **汇报**：告知用户写入路径 + 关联了哪些旧页。

## frontmatter 模板

```yaml
---
title: "<中文标题>"
tags: [wiki/<分类>, compiled]
type: "<分类>"
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
project: "<项目名，可选>"
related:
  - "[[wiki/分类/相关页]]"
cssclasses: [<分类>]
---
```

> 不要手写 quality_score/compiled_by/source——管线自动维护。

## 正文写作规则

- 中文标题与正文；决策页带背景/选项/结论/理由结构（参考 templates/t-ADR.md）。
- 每条知识自包含：即使脱离来源也能读懂（管线会把 raw 会话归档）。
- 涉及密钥/凭据：绝不写入 wiki；涉及路径写相对 vault 路径。
- 剪藏/引用类：只写摘要 + 原文链接，不复制全文（外部库内容不复制原则）。

## 更新已有页面

- 找到旧页 → read → 在原文基础上增补（新信息、更正、标注 superseded）。
- 决策被推翻：旧页加 superseded_by 标记，不删除。

## 写入后

- 管线脚本（~/bin/llm-wiki-pipeline，或会话结束自动触发）会执行：lint → 索引重建 → 记忆体同步（新页面进 mnemon recall）。
- 若管线未运行，可手动提醒用户运行，或告知"会话结束后自动处理"。
- 质量反馈闭环：用户评价页面有用/过时 → `node ~/bin/llm-wiki-pipeline.mjs --rate <路径> --rating useful|outdated`（useful 升 quality_score，outdated 标 stale）；管线 --usage 自动把记忆体召回热度回写 queried_count。
