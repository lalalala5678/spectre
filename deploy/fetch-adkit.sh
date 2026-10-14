#!/bin/bash
# 内网纵深弹药供给——impacket(共享 py 层) + Responder(仓库工具)
# 用法: fetch-adkit.sh [目标根](默认 /var/lib/spectre; 层落 <根>/tools。容器内权威调用: bash /opt/tools/fetch-adkit.sh /opt)
set -u  # fetch 族制式(累积式: set -u+失败汇总); 本脚本两段幂等哨兵, 段失败显式 exit
cd "$(dirname "$0")/.."
DST="${1:-${SPECTRE_DATA_DIR:-/var/lib/spectre}}"
TOOLS="$DST/tools"

# 生产缺省路径守卫(族制式——R13-1 起): 解析后判, env 尾斜杠变体不放行
DST_N=$(realpath -m "$DST")
if [ "$DST_N" = "/var/lib/spectre" ] && [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
  echo "[fetch-adkit] 拒绝: 目标为生产缺省路径 $DST——设 SPECTRE_DATA_DIR=<隔离目录> 或 SPECTRE_ALLOW_DEFAULT_DATA=1" >&2
  exit 1
fi
mkdir -p "$TOOLS/py" "$TOOLS/bin"

FAILS=0

# ── impacket: pip --target 共享层(公理二: 装一次全员可用) ──
# 升级哨兵携带版本指纹(fetch-wordlists .done 同治, CS35-6): 版本不符重装。
# 暂存-成功后换入: pip/clone 失败保留旧版在用安装(族制式"保留成功段,
# 重跑补齐"——先删后取会让失败重跑留下指向空层的死薄壳, 复盘废案)。
IMPACKET_VER="0.12.0"
# 解释器 ABI 指纹: C 扩展(cffi/netifaces)按构建解释器落 cpXY 标签——
# 宿主 3.12 构建的层在容器 3.11 下死载。权威构建位=消费解释器(容器内
# `docker exec "$SBX" bash /opt/tools/fetch-adkit.sh /opt`($1=容器内有效根, 层落 /opt/tools), README
# 步骤 6); 指纹哨兵保证换解释器重跑即整层重建。
PY_TAG=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_NODOT=$(echo "$PY_TAG" | tr -d .)
IMPKG_MARK="$TOOLS/py/.adkit-impacket.ver"
if [ -d "$TOOLS/py/impacket" ] && [ "$(cat "$IMPKG_MARK" 2>/dev/null)" = "$IMPACKET_VER/$PY_TAG" ]; then
  echo "[fetch-adkit] impacket $IMPACKET_VER 已在位——跳过"
else
  echo "[fetch-adkit] impacket $IMPACKET_VER → $TOOLS/py"
  STAGE=$(mktemp -d)
  # python3 -m pip 可移植(容器/最小系统均可用); PEP 668 系统回退 --break-system-packages
  if python3 -m pip install --quiet --target "$STAGE" "impacket==$IMPACKET_VER" \
     || python3 -m pip install --quiet --break-system-packages --target "$STAGE" "impacket==$IMPACKET_VER"; then
    rm -rf "$TOOLS/py/impacket" "$TOOLS/py"/impacket-*.dist-info "$TOOLS/py/bin"
    cp -a "$STAGE"/. "$TOOLS/py/"
    echo "$IMPACKET_VER/$PY_TAG" > "$IMPKG_MARK"
  else
    echo "[fetch-adkit][FAIL] impacket 安装失败(旧版保留, 重跑补齐)" >&2; FAILS=$((FAILS+1))
  fi
  rm -rf "$STAGE"
fi

if [ -d "$TOOLS/py/impacket" ]; then
  # examples 入口: pip 把全部 console 脚本落在 $TOOLS/py/bin/*.py(60+)
  # ——全量生成同名薄壳到 PATH 层(不加手写清单, 零漂移)。薄壳按 $0 自
  # 定位共享层: 宿主运行位与容器挂载位(数据根 tools → /opt/tools)通用,
  # 生成物不烘焙任何绝对路径。
  for f in "$TOOLS/py/bin/"*.py; do
  name=$(basename "$f")
  cat > "$TOOLS/bin/$name" <<EOF
#!/bin/sh
# impacket 入口薄壳(fetch-adkit 生成)——\$0 自定位共享层, 宿主/容器挂载位通用
ROOT=\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)
PYTHONPATH="\$ROOT/py:\${PYTHONPATH:-}" exec python3 "\$ROOT/py/bin/$name" "\$@"
EOF
  chmod +x "$TOOLS/bin/$name"
  done
  echo "[fetch-adkit] impacket 薄壳 ×$(ls "$TOOLS/py/bin/"*.py 2>/dev/null | wc -l) → $TOOLS/bin"
fi

# ── Responder: 固定 tag 浅克隆(tag 哨兵治理升级, 同 impacket 制式) ──
RESPONDER_TAG="v3.1.4.0"
RESP_MARK="$TOOLS/Responder/.adkit-tag"
if [ -d "$TOOLS/Responder" ] && [ "$(cat "$RESP_MARK" 2>/dev/null)" = "$RESPONDER_TAG" ]; then
  echo "[fetch-adkit] Responder $RESPONDER_TAG 已在位——跳过"
else
  echo "[fetch-adkit] Responder $RESPONDER_TAG → $TOOLS/Responder"
  STAGE_R=$(mktemp -d)
  if git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$RESPONDER_TAG" \
    https://github.com/lgandx/Responder.git "$STAGE_R/Responder"; then
    rm -rf "$TOOLS/Responder"
    mv "$STAGE_R/Responder" "$TOOLS/Responder"
    echo "$RESPONDER_TAG" > "$RESP_MARK"
  else
    echo "[fetch-adkit][FAIL] Responder 克隆失败(旧版保留, 重跑补齐)" >&2; FAILS=$((FAILS+1))
  fi
  rm -rf "$STAGE_R"
fi
# Responder 硬依赖 netifaces(requirements.txt; utils.py 缺失即启动退出)
# ——入共享 py 层(与 impacket 同层, 薄壳/直呼均可见)
if ! ls "$TOOLS/py/netifaces.cpython-${PY_NODOT}"*.so >/dev/null 2>&1; then  # C 扩展按解释器 ABI 落单 .so——哨兵=文件+当前 PY_TAG(目录判永真, 勿改回)
  python3 -m pip install --quiet --target "$TOOLS/py" netifaces \
    || python3 -m pip install --quiet --break-system-packages --target "$TOOLS/py" netifaces \
    || echo "[fetch-adkit][warn] netifaces 装失败——Responder 启动需自补(python3-netifaces)" >&2
fi

if [ "$FAILS" -gt 0 ]; then
  echo "[fetch-adkit] 完成(带 $FAILS 项失败, 见上行)→ $TOOLS" >&2
  exit 1
fi
echo "[fetch-adkit] 完成 → $TOOLS"
echo "  验证: $TOOLS/bin/GetUserSPNs.py -h 2>&1 | head -3(应打印 usage; 容器内 PATH 已含 /opt/tools/bin)"
echo "  Responder: PYTHONPATH=$TOOLS/py python3 $TOOLS/Responder/Responder.py -I <iface> -A(分析模式先跑)"
