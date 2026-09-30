#!/bin/bash
# 技能播种: 仓库 docs/ → 运行时 skills 树(新装机器此前 0 挂载, 部署审计 F2)
# 映射表 skills-seed.map 以平台 canonical 清单为准(9 agent / 55 技能)
set -e
DST="${1:-${SPECTRE_DATA_DIR:-/var/lib/spectre}}"
# NEW-B(十一轮): 未显式指定数据根而解析为生产缺省路径时拦截——六轮 G4/
# 九轮 F-C 同类防护此前唯独漏了本脚本(十一轮审计真实触发覆写)。
if [ -z "$SPECTRE_DATA_DIR" ] && [ -z "$1" ] && [ "$DST" = "/var/lib/spectre" ]; then
  if [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
    echo "[skills-seed] 拒绝: 未设 SPECTRE_DATA_DIR 且目标为生产缺省路径 $DST" >&2
    echo "[skills-seed] 设 SPECTRE_DATA_DIR=<隔离目录>, 或显式 SPECTRE_ALLOW_DEFAULT_DATA=1 确认写入生产" >&2
    exit 1
  fi
  echo "[skills-seed] 警告: SPECTRE_ALLOW_DEFAULT_DATA=1 —— 写入生产路径 $DST" >&2
fi
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

# 播种后刷新运行时挂载缓存(需 runtime 在跑 + INTERNAL_TOKEN + 同 PORT)
# NEW-C(十一轮): curl 补 -f 消除 401 假成功; PORT 与 runtime 启动同源。
RT_PORT="${PORT:-8090}"
if [ -n "${INTERNAL_TOKEN:-}" ] && curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${RT_PORT}/api/health"; then
  if curl -sf -X POST -H "X-Internal-Token: ${INTERNAL_TOKEN}" \
      "http://127.0.0.1:${RT_PORT}/api/sandbox/skills/rebuild" >/dev/null; then
    echo "[skills-seed] 挂载缓存已刷新(PORT=$RT_PORT)"
  else
    echo "[skills-seed] 刷新失败: runtime 在 :$RT_PORT 但 token 无效或路由拒绝" >&2
  fi
else
  echo "提示: runtime 未运行(探测 :$RT_PORT, 与后端同 PORT env)——下次启动自动装载"
fi
