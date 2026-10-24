#!/usr/bin/env bash
# dsh-llm-wiki 安装脚本（Linux / WSL）：插件 + 技能 + 9 个脚本 + systemd(pipeline)
# 平台范围：Windows 版计划任务齐全；Linux 目前只装 pipeline timer，编译/保鲜/健康需自行加 timer。
set -euo pipefail
REPO=$(cd "$(dirname "$0")" && pwd)
VAULT=${LLM_WIKI_VAULT:-/mnt/d/DB/Obsidian/LLM-Wiki}
PROFILE=${DSH_PROFILE:-web}
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
BIN=${DSH_BIN:-$HOME/bin}
SCRIPTS="llm-wiki-pipeline.mjs wiki-retrieval.mjs wiki-router.mjs profile-extract.mjs profile-distill.mjs session-compile-candidates.mjs stale-review.mjs pipeline-health.mjs embed-proxy.mjs"
echo "==> 1/5 插件 -> $DSH_HOME/profiles/$PROFILE/"
mkdir -p "$DSH_HOME/profiles/$PROFILE"
cp "$REPO/plugin/dsh-llm-wiki.mjs" "$DSH_HOME/profiles/$PROFILE/"
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
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
echo "==> 3/5 脚本 -> $BIN/"
mkdir -p "$BIN"
for s in $SCRIPTS; do cp "$REPO/scripts/$s" "$BIN/"; chmod +x "$BIN/$s"; done
echo "==> 4/5 systemd 单元 -> ~/.config/systemd/user/"
mkdir -p "$HOME/.config/systemd/user"
cp "$REPO/systemd/llm-wiki-pipeline.service" "$REPO/systemd/llm-wiki-pipeline.timer" "$REPO/systemd/embed-proxy.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable --now embed-proxy.service 2>/dev/null || true
systemctl --user enable --now llm-wiki-pipeline.timer 2>/dev/null || true
echo "==> 5/5 提示"
echo "  vault 路径: $VAULT（管线可用 LLM_WIKI_VAULT 覆盖；SKILL 中的路径请按本机修改）"
echo "  首次全量: node $BIN/llm-wiki-pipeline.mjs --all"
echo "  健康快照: node $BIN/pipeline-health.mjs"
echo "  重启 dsh web 使插件生效: systemctl --user restart dsh-web"
echo "  Linux 周任务（可选）：为 profile-distill / session-compile-candidates / stale-review 自行加 timer"
echo "安装完成。"
