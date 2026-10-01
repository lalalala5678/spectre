#!/bin/bash
# fetch-wordlists — 爆破字典与 jwt_tool 供给(R32D57-NEW6: 技能引用
# /opt/tools/{seclists,wordlists,jwt_tool} 此前零供给面)。
# 产物 ~250MB 不入 git; 落 /opt/tools(CLI 共享层, 全员可用)。
# 幂等: 分段 .done 标记——半量交付重跑只补缺段。
set -euo pipefail

TOOLS=/opt/tools
ANY_FAILED=0

# seclists: 稀疏克隆只取技能实际引用的目录(cone 模式只认目录——
# 文件路径会使整组 pattern 失效, R32D57 实测踩坑)。
if [ ! -f "$TOOLS/seclists/.done" ]; then
  SL_FAILED=0
  TMP=$(mktemp -d)
  if git clone --depth 1 --filter=blob:none --sparse \
      https://github.com/danielmiessler/SecLists "$TMP/sl" 2>"$TMP/err"; then
    (cd "$TMP/sl" && git sparse-checkout set Usernames Discovery/SNMP)
    mkdir -p "$TOOLS/seclists"
    cp -r "$TMP/sl/Usernames" "$TMP/sl/Discovery" "$TOOLS/seclists/" 2>/dev/null || SL_FAILED=1
    [ "$SL_FAILED" = "0" ] && touch "$TOOLS/seclists/.done"
  else
    echo "[fetch-wordlists] SecLists 克隆失败: $(tail -1 "$TMP/err" 2>/dev/null || echo 网络?)" >&2
    SL_FAILED=1
  fi
  rm -rf "$TMP"
  [ "$SL_FAILED" = "1" ] && ANY_FAILED=1
fi

# rockyou: 直连单文件(134MB, 免 tar/免 seclists 文件位稀疏)
if [ ! -f "$TOOLS/wordlists/.rockyou-done" ]; then
  RK_FAILED=0
  mkdir -p "$TOOLS/wordlists"
  if curl -sfL --retry 2 -o "$TOOLS/wordlists/rockyou.txt" \
      https://github.com/brannondorsey/naive-hashcat/releases/download/data/rockyou.txt; then
    touch "$TOOLS/wordlists/.rockyou-done"
  else
    echo "[fetch-wordlists] rockyou 下载失败(网络?)——重跑补齐" >&2
    rm -f "$TOOLS/wordlists/rockyou.txt"
    RK_FAILED=1
  fi
  [ "$RK_FAILED" = "1" ] && ANY_FAILED=1
fi

# jwt_tool: web-login-brute 引用(/opt/tools/jwt_tool/jwt_tool.py)
if [ ! -f "$TOOLS/jwt_tool/.done" ]; then
  JT_FAILED=0
  TMP=$(mktemp -d)
  if git clone --depth 1 https://github.com/ticarpi/jwt_tool "$TMP/jwt" 2>"$TMP/err2"; then
    mkdir -p "$TOOLS/jwt_tool"
    cp -r "$TMP/jwt/." "$TOOLS/jwt_tool/" 2>/dev/null || JT_FAILED=1
    # 依赖入共享 py 层——失败仅 warn(部分模式缺 pycryptodome 才受限)
    if [ -f "$TOOLS/jwt_tool/requirements.txt" ]; then
      pip install --target "$TOOLS/py" -q -r "$TOOLS/jwt_tool/requirements.txt" 2>/dev/null \
        || echo "[fetch-wordlists][warn] jwt_tool 依赖装失败(pypi 不可达?)——缺库模式自装" >&2
    fi
    [ "$JT_FAILED" = "0" ] && touch "$TOOLS/jwt_tool/.done"
  else
    echo "[fetch-wordlists] jwt_tool 克隆失败: $(tail -1 "$TMP/err2" 2>/dev/null || echo 网络?)" >&2
    JT_FAILED=1
  fi
  rm -rf "$TMP"
  [ "$JT_FAILED" = "1" ] && ANY_FAILED=1
fi

if [ "$ANY_FAILED" = "1" ]; then
  echo "[fetch-wordlists] ✗ 部分供给失败——已保留成功段, 重跑补齐" >&2
  exit 1
fi
echo "[fetch-wordlists] 完成: seclists(Usernames+Discovery/SNMP) + wordlists/rockyou.txt + jwt_tool"
