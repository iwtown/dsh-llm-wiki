# dsh-llm-wiki

> Karpathy LLM Wiki 模式的 DeepSeek Harness 知识库系统：模型写 wiki、管线维护、记忆体召回、质量闭环。

基于 [Karpathy 的 LLM Wiki 理念](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 的 Obsidian 知识库自动化方案。整套系统由 **1 个极简插件 + 2 个技能 + 1 个管线脚本 + 1 个向量代理服务** 组成，刻意保持低代码、零第三方插件依赖。

## 架构

```
写：wiki-write SKILL → 模型会话内写 Obsidian wiki 页面（frontmatter/wikilink 规范）
管：llm-wiki-pipeline.mjs（lint/索引/记忆体同步/usage/rate，零依赖，幂等）
     ├─ systemd timer 每日 03:00 自动运行
     └─ 插件 session/disposed 事件触发（60s 防重入）
记：mnemon 记忆体 223 条 wiki 精华（向量语义召回）
读：wiki-search SKILL（rg + read 检索原文）
馈：--rate 质量反馈 / --usage 召回热度回写 queried_count
向：embed-proxy.mjs（Ollama 兼容代理 → SiliconFlow /v1/embeddings，可选）
```

| 组件 | 文件 | 部署位置 |
|---|---|---|
| 生命周期插件 | plugin/dsh-llm-wiki.mjs | ~/.dsh/profiles/web/（cordis.patch.yml 挂载） |
| 检索技能 | skills/wiki-search/SKILL.md | ~/.agents/skills/wiki-search/ |
| 写入技能 | skills/wiki-write/SKILL.md | ~/.agents/skills/wiki-write/ |
| 管线 | scripts/llm-wiki-pipeline.mjs | ~/bin/ |
| 向量代理 | scripts/embed-proxy.mjs | ~/bin/ + systemd 服务 |
| 定时 | systemd/llm-wiki-pipeline.timer | ~/.config/systemd/user/ |

## 依赖

- dsh >= 0.1.1-rc.2（web profile）
- Node.js >= 22.19（管线用 node:sqlite）
- ripgrep（wiki-search 检索）
- mnemon CLI + dsh-mnemon 插件（记忆体）
- Obsidian vault（wiki 页面），目录结构见 [wiki 结构](#wiki-结构)
- SiliconFlow API key（可选，用于向量召回；复用 ~/.modlens/config.json 或环境变量 EMBED_KEY）

## 安装

```bash
git clone https://github.com/<you>/dsh-llm-wiki.git
cd dsh-llm-wiki && ./install.sh
systemctl --user restart dsh-web   # 让插件生效
```

`install.sh` 会把各组件复制到上述位置并启用 systemd 服务。然后：

1. **配置 vault 路径**：默认 /mnt/d/DB/Obsidian/LLM-Wiki（管线可用环境变量 LLM_WIKI_VAULT 覆盖；插件在 cordis.patch.yml 的 config.vault 覆盖；**SKILL 文件中的路径需按本机修改**）
2. **首次记忆体同步**：`node ~/bin/llm-wiki-pipeline.mjs --sync`（把 wiki 精华导入 mnemon）
3. **可选向量**：确认 embed-proxy 服务运行后 `mnemon embed --all` 补齐向量

## 使用

- **写入知识**：直接说"把这个记到知识库"，模型按 wiki-write 技能写入对应分类
- **检索知识**：问"之前怎么做的"，模型按 wiki-search 技能检索并引用原文
- **手动管线**：`node ~/bin/llm-wiki-pipeline.mjs --all`
- **质量反馈**：`node ~/bin/llm-wiki-pipeline.mjs --rate wiki/决策/xxx.md --rating useful|outdated`

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
├── schema.md        # 运行时守则（插件注入到系统提示）
├── log.md           # 操作日志（管线追加）
├── raw/             # 原始源（会话/剪藏，只读）
└── wiki/            # 编译层（12 分类：决策/发现/概念/项目/流程/命令/规则/提示/记忆/基因/引用/索引）
    ├── index.md     # 管线重建的导航（插件注入到系统提示）
    └── <分类>/      # 页面：frontmatter（title/type/created/related/quality_score）+ wikilink >= 2
```

## 设计原则

- **反脆弱**：检索/写入用 SKILL + DSH 原生工具（零插件故障面）；只有"必须进程内"的注入与事件钩子才进插件（~90 行）
- **幂等**：管线 mtime 增量检测，重复运行无副作用
- **闭环**：使用数据（recall 命中）→ queried_count → quality_score → 影响召回
- **本地优先**：wiki 与记忆体全本地，向量可选云端

## License

MIT
