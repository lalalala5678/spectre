#!/bin/bash
# 仓库工具链 → 运行时数据目录(private-qa.service 等的引用路径)
# 用法: tools-sync.sh [目标根](默认 /var/lib/spectre)
set -e
DST="${1:-${SPECTRE_DATA_DIR:-/var/lib/spectre}}"
# R13-1(十三轮): 生产缺省路径守卫——与 skills-seed NEW-B 同款(该脚本
# 上轮已实测漏 env 直写生产; 十三轮再次真实触发)。
if [ -z "$SPECTRE_DATA_DIR" ] && [ -z "$1" ] && [ "$DST" = "/var/lib/spectre" ]; then
  if [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
    echo "[tools-sync] 拒绝: 未设 SPECTRE_DATA_DIR 且目标为生产缺省路径 $DST" >&2
    echo "[tools-sync] 设 SPECTRE_DATA_DIR=<隔离目录>, 或显式 SPECTRE_ALLOW_DEFAULT_DATA=1" >&2
    exit 1
  fi
  echo "[tools-sync] 警告: SPECTRE_ALLOW_DEFAULT_DATA=1 —— 写入生产路径 $DST" >&2
fi
mkdir -p "$DST/tools/bin" "$DST/tools/c2"
cp -v tools/bin/*.py "$DST/tools/bin/"
for d in basetypes basetypes-jakarta javastubs yara-rules mock; do
  [ -d "tools/c2/$d" ] && cp -r "tools/c2/$d" "$DST/tools/c2/"
done
cp -v tools/c2/private-qa-server.py tools/c2/mcp-echo.mjs "$DST/tools/c2/"
[ -f docs/recon-skills/mcp-recon-datasources.mjs ] && cp -v docs/recon-skills/mcp-recon-datasources.mjs "$DST/"
[ -f docs/nday-skills/mcp-nday-intel.mjs ] && cp -v docs/nday-skills/mcp-nday-intel.mjs "$DST/"
echo "[tools-sync] 完成 → $DST (注意: 沙箱容器重建后经平台 installCli 账本恢复系统包)"
# NEW-A(十一轮): 沙箱引导脚本同步——容器内 /opt/tools 即数据根挂载,
# deploy/README 第 6 步引用的 /opt/tools/bootstrap-sandbox.sh 由这里交付
cp -v deploy/bootstrap-sandbox.sh deploy/fetch-jars.sh "$DST/tools/" || { echo "[tools-sync] 引导脚本同步失败" >&2; exit 1; }
