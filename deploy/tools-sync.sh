#!/bin/bash
# 仓库工具链 → 运行时数据目录(private-qa.service 等的引用路径)
# 用法: tools-sync.sh [目标根](默认 /var/lib/spectre)
set -e
DST="${1:-/var/lib/spectre}"
mkdir -p "$DST/tools/bin" "$DST/tools/c2"
cp -v tools/bin/*.py "$DST/tools/bin/" 2>/dev/null || true
for d in basetypes basetypes-jakarta javastubs yara-rules mock; do
  [ -d "tools/c2/$d" ] && cp -r "tools/c2/$d" "$DST/tools/c2/" 2>/dev/null || true
done
cp -v tools/c2/private-qa-server.py tools/c2/mcp-echo.mjs "$DST/tools/c2/" 2>/dev/null || true
cp -v tools/c2/mcp-nday-intel.mjs tools/c2/mcp-recon-datasources.mjs "$DST/" 2>/dev/null || true
[ -f docs/recon-skills/mcp-recon-datasources.mjs ] && cp -v docs/recon-skills/mcp-recon-datasources.mjs "$DST/" 2>/dev/null || true
[ -f docs/nday-skills/mcp-nday-intel.mjs ] && cp -v docs/nday-skills/mcp-nday-intel.mjs "$DST/" 2>/dev/null || true
echo "[tools-sync] 完成 → $DST (注意: 沙箱容器重建后经平台 installCli 账本恢复系统包)"
