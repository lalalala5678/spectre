#!/bin/bash
# R32D55-N1: 指纹库供给(nt-technologies + plugins-0x727, 共 ~20MB 实测不入 git)。
# 目标: $SPECTRE_DATA_DIR/tools/fingerprints/; 失败汇总非零退出。
ROOT=${SPECTRE_DATA_DIR:-/var/lib/spectre}
DEST=${FP_DIR:-$ROOT/tools/fingerprints}
# R32D56/CS31: N2 同款真修——按解析后目标判(尾斜杠变体此前直穿)。
DEST_N=$(realpath -m "$DEST")
if [ "$DEST_N" = "/var/lib/spectre/tools/fingerprints" ]; then
  if [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
    echo "[fetch-fingerprints] 拒绝: 目标为生产缺省路径 $DEST(解析为 $DEST_N)——设 SPECTRE_DATA_DIR=<隔离目录> 或显式 SPECTRE_ALLOW_DEFAULT_DATA=1" >&2
    exit 1
  fi
  echo "[fetch-fingerprints] 警告: SPECTRE_ALLOW_DEFAULT_DATA=1 —— 写入生产路径 $DEST_N" >&2
fi
mkdir -p "$DEST/nt-technologies" "$DEST/plugins-0x727"
FAILED=0
# nt-technologies: nuclei 官方模板库的 technologies 子集(浅克隆+拷贝)
NT_DONE="$DEST/.nt-done"
if [ ! -f "$NT_DONE" ]; then
  TMP=$(mktemp -d)
  if git clone --depth 1 --filter=blob:none --sparse https://github.com/projectdiscovery/nuclei-templates "$TMP/nt" 2>/dev/null \
     && (cd "$TMP/nt" && git sparse-checkout set http/technologies 2>/dev/null); then
    cp "$TMP/nt/http/technologies/"*.yaml "$DEST/nt-technologies/" 2>/dev/null || FAILED=1
    [ "${FAILED:-0}" = "0" ] && touch "$NT_DONE"
  else
    FAILED=1
  fi
  rm -rf "$TMP"
fi
# plugins-0x727: wappalyzer httpx 插件库(活仓 FingerprintHub, plugins/<作者>/)
# CS32-F11: 哨兵用完成标记(此前 0xjacky 子目录——半量交付后重跑被误跳过)
DONE_FLAG="$DEST/.plugins-done"
if [ ! -f "$DONE_FLAG" ]; then
  TMP=$(mktemp -d)
  if git clone --depth 1 https://github.com/0x727/FingerprintHub "$TMP/plugins" 2>"$TMP/err"; then
    if [ -d "$TMP/plugins/plugins" ]; then
      cp -r "$TMP/plugins/plugins/"*/ "$DEST/plugins-0x727/" 2>/dev/null || FAILED=1
    else
      cp -r "$TMP/plugins/"*/ "$DEST/plugins-0x727/" 2>/dev/null || FAILED=1
    fi
    [ "${FAILED:-0}" = "0" ] && touch "$DONE_FLAG"
  else
    echo "[fetch-fingerprints] plugins 库克隆失败: $(tail -1 "$TMP/err" 2>/dev/null || echo 网络?)" >&2
    FAILED=1
  fi
  rm -rf "$TMP"
fi
if [ "$FAILED" = "1" ]; then
  echo "[fetch-fingerprints] ✗ 部分库拉取失败(网络?)——已保留成功部分, 重跑补齐" >&2
  exit 1
fi
echo "[fetch-fingerprints] 完成: $DEST ($(ls "$DEST/nt-technologies" | wc -l) nuclei 模板 + $(ls "$DEST/plugins-0x727" | wc -l) 插件目录)"
