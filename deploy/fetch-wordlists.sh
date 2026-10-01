#!/bin/bash
# fetch-wordlists — 爆破字典与 jwt_tool 供给(R32D57-NEW6: 技能引用
# seclists/rockyou/jwt_tool 此前零供给面)。
# 产物 ~705MB 实测不入 git; 落 ${SPECTRE_DATA_DIR:-/var/lib/spectre}/tools
# (容器内经 bind 挂载解析为 /opt/tools——与技能消费路径同一模型,
# CS34-F2b: 此前硬编码宿主 /opt/tools 绕过数据根双运行位制式)。
# 幂等: 分段 .done 标记——半量交付重跑只补缺段; seclists 标记携带
# 稀疏集指纹, 同段扩集后旧装机重跑自动补齐(CS35-6)。
set -u  # CS45-N6: 族制式——累积式(jars/fingerprints/wordlists)=set -u 不用 -e(ANY_FAILED 显式汇总)

TOOLS="${SPECTRE_DATA_DIR:-/var/lib/spectre}/tools"
# 生产路径守卫族(同 tools-sync 等; realpath 归一尾斜杠变体)
TOOLS_N=$(realpath -m "$TOOLS")
if [ "$TOOLS_N" = "/var/lib/spectre/tools" ]; then
  if [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
    echo "[fetch-wordlists] 拒绝: 目标为生产缺省路径 $TOOLS(解析为 $TOOLS_N)——设 SPECTRE_DATA_DIR=<隔离目录> 或显式 SPECTRE_ALLOW_DEFAULT_DATA=1" >&2
    exit 1
  fi
  echo "[fetch-wordlists] 警告: SPECTRE_ALLOW_DEFAULT_DATA=1 —— 写入生产路径 $TOOLS_N" >&2
fi
ANY_FAILED=0

# seclists: 稀疏克隆只取技能/平台实际引用的目录(cone 模式只认目录——
# 文件路径会使整组 pattern 失效, R32D57 实测踩坑)。
# CS34-F2a: 消费面含 Discovery/Web-Content+DNS(agent-settings/
# dir-brute/pi 提示词), 此前稀疏集缺这两目录。
SPARSE_SET="Usernames Discovery/SNMP Discovery/Web-Content Discovery/DNS"
# CS39-5: 指纹带 v2 前缀——BG 期拍平装机的旧 .done(裸集合串)不匹配,
# 重跑自动以嵌套结构重拷(升级面断供封堵)。
SPARSE_FP="v2:$SPARSE_SET"
# CS35-6: 标记携带稀疏集指纹——同段扩集(如本版补 Web-Content/DNS)后
# 旧装机重跑自动补齐, 而非被无版本 .done 跳段(供给断链的升级面)。
if [ "$(cat "$TOOLS/seclists/.done" 2>/dev/null)" != "$SPARSE_FP" ]; then
  SL_FAILED=0
  TMP=$(mktemp -d)
  if git clone --depth 1 --filter=blob:none --sparse \
      https://github.com/danielmiessler/SecLists "$TMP/sl" 2>"$TMP/err"; then
    (cd "$TMP/sl" && git sparse-checkout set $SPARSE_SET)  # CS36-Z5: 集合单源(指纹同锚)
    mkdir -p "$TOOLS/seclists"
    # CS37 观测项/CS38-G1: 拷贝面由 SPARSE_SET 派生——取顶层分量去重
    # (Discovery/SNMP → Discovery, 保上游嵌套结构; 此前逐项 cp 把
    # SNMP 拍平到 seclists/ 顶层, dir-brute/DNS 消费路径断供), 缺件即败。
    for top in $(printf '%s\n' $SPARSE_SET | cut -d/ -f1 | sort -u); do
      cp -r "$TMP/sl/$top" "$TOOLS/seclists/" 2>/dev/null \
        || { echo "[fetch-wordlists] 拷贝缺件: $top" >&2; SL_FAILED=1; }
    done
    [ "$SL_FAILED" = "0" ] && printf '%s' "$SPARSE_FP" > "$TOOLS/seclists/.done"
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

# jwt_tool: web-login-brute 引用(jwt_tool/jwt_tool.py)
if [ ! -f "$TOOLS/jwt_tool/.done" ]; then
  JT_FAILED=0
  TMP=$(mktemp -d)
  if git clone --depth 1 https://github.com/ticarpi/jwt_tool "$TMP/jwt" 2>"$TMP/err2"; then
    mkdir -p "$TOOLS/jwt_tool"
    cp -r "$TMP/jwt/." "$TOOLS/jwt_tool/" 2>/dev/null || JT_FAILED=1
    # 依赖入共享 py 层——失败仅 warn(部分模式缺 pycryptodome 才受限)。
    # CS34-F2c: 目标基镜像 debian:bookworm(PEP 668)须
    # --break-system-packages(照 bootstrap-sandbox.sh 先例)。
    if [ -f "$TOOLS/jwt_tool/requirements.txt" ]; then
      pip install --target "$TOOLS/py" -q --break-system-packages \
        -r "$TOOLS/jwt_tool/requirements.txt" 2>/dev/null \
        || pip install --target "$TOOLS/py" -q -r "$TOOLS/jwt_tool/requirements.txt" 2>/dev/null \
        || echo "[fetch-wordlists][warn] jwt_tool 依赖装失败(网络?)——缺库模式自装" >&2
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
echo "[fetch-wordlists] 完成: $TOOLS_N/seclists(Usernames+Discovery/{SNMP,Web-Content,DNS}) + wordlists/rockyou.txt + jwt_tool(容器内经挂载即 /opt/tools/...)"
