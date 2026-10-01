#!/bin/bash
# 技能播种: 仓库 docs/ → 运行时 skills 树(新装机器此前 0 挂载, 部署审计 F2)
# 映射表 skills-seed.map 以平台 canonical 清单为准(9 agent / 55 技能)
set -e  # CS45-N6: 族制式——即时式(sync/seed/bootstrap)=set -e 失败即停
DST="${1:-${SPECTRE_DATA_DIR:-/var/lib/spectre}}"
# NEW-B(十一轮): 未显式指定数据根而解析为生产缺省路径时拦截——六轮 G4/
# 九轮 F-C 同类防护此前唯独漏了本脚本(十一轮审计真实触发覆写)。
if [ "$(realpath -m "$DST")" = "/var/lib/spectre" ]; then  # R32D55-N2(真修): 按解析后目标判
  if [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
    echo "[skills-seed] 拒绝: 目标为生产缺省路径 $DST(解析为 $(realpath -m "$DST"))——设 SPECTRE_DATA_DIR=<隔离目录> 或显式 SPECTRE_ALLOW_DEFAULT_DATA=1" >&2
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
if [ -z "${INTERNAL_TOKEN:-}" ]; then
  echo "提示: 未设 INTERNAL_TOKEN——跳过挂载刷新; 下次启动自动装载(如需即时刷新, 导出 backend/.env 的 INTERNAL_TOKEN)"
elif curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:${RT_PORT}/api/health"; then
  if curl -sf -X POST -H "X-Internal-Token: ${INTERNAL_TOKEN}" \
      "http://127.0.0.1:${RT_PORT}/api/sandbox/skills/rebuild" >/dev/null; then
    echo "[skills-seed] 挂载缓存已刷新(PORT=$RT_PORT)"
  else
    echo "[skills-seed] 刷新失败: runtime 在 :$RT_PORT 但 token 无效或路由拒绝" >&2
  fi
else
  echo "提示: :$RT_PORT 未探测到 runtime(与后端同 PORT env)——下次启动自动装载"
fi
