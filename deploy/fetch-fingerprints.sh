#!/bin/bash
# R32D55-N1: 指纹库供给(nt-technologies + plugins-0x727, 共 ~45MB 不入 git)。
# 目标: $SPECTRE_DATA_DIR/tools/fingerprints/; 失败汇总非零退出。
ROOT=${SPECTRE_DATA_DIR:-/var/lib/spectre}
DEST=${FP_DIR:-$ROOT/tools/fingerprints}
if [ -z "$SPECTRE_DATA_DIR" ] && [ "$DEST" = "/var/lib/spectre/tools/fingerprints" ]; then
  if [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
    echo "[fetch-fingerprints] 拒绝: 未设 SPECTRE_DATA_DIR 且目标为生产缺省路径 $DEST" >&2
    echo "[fetch-fingerprints] 设 SPECTRE_DATA_DIR=<隔离目录>, 或显式 SPECTRE_ALLOW_DEFAULT_DATA=1" >&2
    exit 1
  fi
fi
mkdir -p "$DEST/nt-technologies" "$DEST/plugins-0x727"
FAILED=0
# nt-technologies: nuclei 官方模板库的 technologies 子集(浅克隆+拷贝)
if [ ! -f "$DEST/nt-technologies/4D-detect.yaml" ]; then
  TMP=$(mktemp -d)
  if git clone --depth 1 --filter=blob:none --sparse https://github.com/projectdiscovery/nuclei-templates "$TMP/nt" 2>/dev/null \
     && (cd "$TMP/nt" && git sparse-checkout set http/technologies 2>/dev/null); then
    cp "$TMP/nt/http/technologies/"*.yaml "$DEST/nt-technologies/" 2>/dev/null || FAILED=1
  else
    FAILED=1
  fi
  rm -rf "$TMP"
fi
# plugins-0x727: wappalyzer httpx 插件库
if [ ! -d "$DEST/plugins-0x727/0xjacky" ]; then
  TMP=$(mktemp -d)
  if git clone --depth 1 https://github.com/0x727/Observer_Web "//$TMP/plugins" 2>/dev/null \
     || git clone --depth 1 https://github.com/0x727/Fingerprint "$TMP/plugins" 2>/dev/null; then
    # 0x727 fingerprint 库结构: 按作者目录
    cp -r "$TMP/plugins/"*/ "$DEST/plugins-0x727/" 2>/dev/null || FAILED=1
  else
    FAILED=1
  fi
  rm -rf "$TMP"
fi
if [ "$FAILED" = "1" ]; then
  echo "[fetch-fingerprints] ✗ 部分库拉取失败(网络?)——已保留成功部分, 重跑补齐" >&2
  exit 1
fi
echo "[fetch-fingerprints] 完成: $DEST ($(ls "$DEST/nt-technologies" | wc -l) nuclei 模板 + $(ls "$DEST/plugins-0x727" | wc -l) 插件目录)"
