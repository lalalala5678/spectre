#!/bin/bash
# 技能播种: 仓库 docs/ → 运行时 skills 树(新装机器此前 0 挂载, 部署审计 F2)
# 映射表 skills-seed.map 以平台 canonical 清单为准(9 agent / 55 技能)
set -e
DST="${1:-${SPECTRE_DATA_DIR:-/var/lib/spectre}}"
cd "$(dirname "$0")/.."
n=0
while IFS='|' read -r key src; do
  [ -z "$key" ] && continue
  agent="${key%%/*}"; skill="${key#*/}"
  if [ ! -f "$src/SKILL.md" ]; then echo "[skills-seed] 跳过(无 SKILL.md): $src" >&2; continue; fi
  mkdir -p "$DST/skills/$agent/$skill"
  cp -r "$src/." "$DST/skills/$agent/$skill/"
  n=$((n+1))
done < deploy/skills-seed.map
echo "[skills-seed] $n 个技能 → $DST/skills/ (新会话生效; 平台内经 skill-config 持续管理)"
