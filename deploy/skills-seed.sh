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
echo "[skills-seed] $n 个技能 → $DST/skills/ (见下方挂载刷新; 平台内经 skill-config 持续管理)"

# 播种后刷新运行时挂载缓存(需 runtime 在跑 + INTERNAL_TOKEN)
if [ -n "${INTERNAL_TOKEN:-}" ] && curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${PORT:-8090}/api/health"; then
  curl -s -X POST -H "X-Internal-Token: ${INTERNAL_TOKEN}" \
    "http://127.0.0.1:${PORT:-8090}/api/sandbox/skills/rebuild" && echo " (挂载缓存已刷新)"
else
  echo "提示: runtime 未运行——下次启动自动装载; 或起后执行 POST /api/sandbox/skills/rebuild"
fi
