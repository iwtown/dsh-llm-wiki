#!/usr/bin/env bash
# dsh-llm-wiki 安装脚本：把组件复制到 DSH 标准位置并启用 systemd 服务
set -euo pipefail
REPO=$(cd "$(dirname "$0")" && pwd)
VAULT=${LLM_WIKI_VAULT:-/mnt/d/DB/Obsidian/LLM-Wiki}

echo "==> 1/5 插件 -> ~/.dsh/profiles/web/"
mkdir -p "$HOME/.dsh/profiles/web"
cp "$REPO/plugin/dsh-llm-wiki.mjs" "$HOME/.dsh/profiles/web/"
PATCH="$HOME/.dsh/profiles/web/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -q llm-wiki "$PATCH"; then
  echo "     cordis.patch.yml 已含 llm-wiki 条目，跳过"
else
  cat >> "$PATCH" << 'EOF'

# dsh-llm-wiki（LLM-Wiki 生命周期插件）
- insert:
    - id: llm-wiki
      name: ./dsh-llm-wiki.mjs
EOF
  echo "     已挂载 cordis.patch.yml"
fi

echo "==> 2/5 技能 -> ~/.agents/skills/"
mkdir -p "$HOME/.agents/skills/wiki-search" "$HOME/.agents/skills/wiki-write"
cp "$REPO/skills/wiki-search/SKILL.md" "$HOME/.agents/skills/wiki-search/"
cp "$REPO/skills/wiki-write/SKILL.md" "$HOME/.agents/skills/wiki-write/"

echo "==> 3/5 脚本 -> ~/bin/"
mkdir -p "$HOME/bin"
cp "$REPO/scripts/llm-wiki-pipeline.mjs" "$HOME/bin/"
cp "$REPO/scripts/embed-proxy.mjs" "$HOME/bin/"
chmod +x "$HOME/bin/llm-wiki-pipeline.mjs" "$HOME/bin/embed-proxy.mjs"

echo "==> 4/5 systemd 单元 -> ~/.config/systemd/user/"
mkdir -p "$HOME/.config/systemd/user"
cp "$REPO/systemd/llm-wiki-pipeline.service" "$REPO/systemd/llm-wiki-pipeline.timer" "$REPO/systemd/embed-proxy.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now embed-proxy.service 2>/dev/null || true
systemctl --user enable --now llm-wiki-pipeline.timer 2>/dev/null || true

echo "==> 5/5 提示"
echo "  vault 路径: $VAULT（管线可用 LLM_WIKI_VAULT 覆盖；SKILL 文件中的路径请按本机修改）"
echo "  首次记忆体同步: node ~/bin/llm-wiki-pipeline.mjs --sync"
echo "  重启 dsh-web 使插件生效: systemctl --user restart dsh-web"
echo "  向量（可选）: mnemon embed --all"
echo "安装完成。"
