#!/bin/bash
# setup — SPECTRE 一键部署(小白默认路径): 依赖→构建→账号→systemd→对外 TLS
# 用法:
#   sudo bash deploy/setup.sh              # 全默认(公网 IP + 内部 CA 证书)
#   sudo bash deploy/setup.sh your.domain.com   # 有域名→自动 Let's Encrypt
# 幂等: 重复运行安全(已装步骤跳过/已接管单元只 restart)。
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  echo '[setup] 须 root 运行: sudo bash deploy/setup.sh [域名]' >&2; exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR=/var/lib/spectre
AUTH_DIR=/etc/spectre-auth
LOG_DIR=/var/log/spectre-console
say() { echo "[setup] $*"; }
die() { echo "[setup] FATAL: $*" >&2; exit 1; }

# ---------- 1) 基础依赖: python3 必在; Node ≥22(缺则 NodeSource 装; 装后复核) ----------
command -v python3 >/dev/null || die 'python3 缺失(apt install python3)'
command -v openssl >/dev/null || die 'openssl 缺失(apt install openssl)——令牌/密码生成依赖它'
NODE_MAJOR="$(node -v 2>/dev/null | grep -oP '\d+' | head -1 || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  say '安装 Node 22(NodeSource)...'
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 \
    || die 'NodeSource setup 脚本失败(网络?)——手动装 Node≥22 后重跑'
  apt-get install -y -qq nodejs >/dev/null 2>&1 || die 'nodejs 安装失败'
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -v | grep -oP '\d+' | head -1)"
[ "${NODE_MAJOR:-0}" -ge 22 ] || die "Node 仍 <22(当前 $(node -v))——手动装后重跑"
say "Node: $($NODE_BIN -v)"

# ---------- 2) 后端依赖 + .env(确保 INTERNAL_TOKEN 有效; 不覆盖已有真值) ----------
cd "$REPO/backend"
[ -f .env ] || cp .env.example .env
if grep -q '^INTERNAL_TOKEN=change-me' .env; then
  sed -i "s|^INTERNAL_TOKEN=.*|INTERNAL_TOKEN=$(openssl rand -hex 32)|" .env
  say '已生成 INTERNAL_TOKEN(backend/.env)'
elif ! grep -q '^INTERNAL_TOKEN=' .env; then
  echo "INTERNAL_TOKEN=$(openssl rand -hex 32)" >> .env
  say '已追加 INTERNAL_TOKEN(backend/.env)'
fi
# 校验: 空值/change-me 都算无效(F7: sed 空转不得谎称成功)。
TOK="$(grep -oP '^INTERNAL_TOKEN=\K\S+' .env || true)"
[ -n "$TOK" ] && [ "$TOK" != "change-me-same-as-backend-env" ] \
  || die 'backend/.env 的 INTERNAL_TOKEN 无效——手动填随机串后重跑'
chmod 600 .env
npm install --no-audit --no-fund --silent

# ---------- 3) 前端构建 ----------
cd "$REPO/console"
npm install --no-audit --no-fund --silent
npm run build --silent
[ -f "$REPO/console/dist/index.html" ] || die '前端构建产物缺失'

# ---------- 4) 整机归属裁决(R32D101-N2: 先裁决再改系统态——共享机防误改) ----------
# 本脚本整机独占: 目标端口已被"非 spectre 单元"占用即停, 此时尚未写
# /etc/spectre、未动账号。共享机/已部署机请走手工路径(deploy/README)。
port_owner() { ss -ltnp 2>/dev/null | grep -P ":$1\b" | grep -oP 'users:\(\(.*' | head -1 || true; }
OWNED_ALREADY=no
if systemctl is-active --quiet spectre-agent-runtime && systemctl is-active --quiet spectre-console; then
  OWNED_ALREADY=yes
else
  O="$(port_owner 8090)"; [ -z "$O" ] || die "8090 被非 spectre-agent-runtime 进程占用: $O——本机已有别的部署? 共享机请走手工路径(deploy/README)"
  O="$(port_owner 8081)"; [ -z "$O" ] || die "8081 被非 spectre-console 进程占用: $O——本机已有别的部署? 共享机请走手工路径(deploy/README)"
fi

# ---------- 5) admin 账号(已存在则跳过) ----------
install -d -m 750 "$AUTH_DIR"
if [ ! -f "$AUTH_DIR/passwd" ]; then
  PW="Spectre-$(openssl rand -hex 4)-Admin"
  SPECTRE_AUTH_DIR="$AUTH_DIR" PASS="$PW" python3 "$REPO/gateway/spectre-passwd.py" add admin >/dev/null 2>&1
  echo "$PW" > /root/spectre-admin-cred.txt && chmod 600 /root/spectre-admin-cred.txt
  say "admin 账号已建, 密码已存 /root/spectre-admin-cred.txt"
fi

# ---------- 5) systemd 环境文件(已存在只更新本脚本管理的键, 保留自定义)+单元 ----------
install -d -m 755 /etc/spectre
ENVF=/etc/spectre/spectre.env
touch "$ENVF"
upsert() { grep -q "^$1=" "$ENVF" && sed -i "s|^$1=.*|$1=$2|" "$ENVF" || echo "$1=$2" >> "$ENVF"; }
upsert SPECTRE_REPO "$REPO"
upsert SPECTRE_DATA_DIR "$DATA_DIR"
upsert NODE_BIN "$NODE_BIN"
upsert INTERNAL_TOKEN "$TOK"
upsert GATEWAY_DIST_DIR "$REPO/console/dist"
chmod 600 "$ENVF"
# R32D100-F1: console 单元 ReadWritePaths 硬编码此目录——无人建则 226/NAMESPACE 拒启;
# R32D101-N1: 同族缺口——oob 单元 ReadWritePaths=$DATA_DIR/oob(全家桶可选启用, 一并预建)。
install -d -m 755 "$LOG_DIR" "$DATA_DIR" "$DATA_DIR/oob"
cp "$REPO"/deploy/systemd/spectre-*.service /etc/systemd/system/
systemctl daemon-reload
if [ "$OWNED_ALREADY" = yes ]; then
  systemctl restart spectre-agent-runtime spectre-console
else
  systemctl enable spectre-agent-runtime spectre-console >/dev/null 2>&1
  systemctl start spectre-agent-runtime || die 'runtime 启动失败: journalctl -u spectre-agent-runtime -n 20'
  systemctl start spectre-console || die 'console 启动失败: journalctl -u spectre-console -n 20'
fi
sleep 2
for U in spectre-agent-runtime spectre-console; do
  systemctl is-active --quiet "$U" || die "$U 未活: journalctl -u $U -n 20"
done
say 'runtime(8090) + 网关(8081) 已由 systemd 托管'

# ---------- 6) 对外 TLS(默认自动化; 域名透传; 失败则明确降级说明, F3) ----------
TLS_OK=yes
bash "$REPO/deploy/setup-tls.sh" "${1:-}" || TLS_OK=no

# ---------- 7) 收尾指引(如实反映 TLS 状态, F3/F8) ----------
PUBIP="$(curl -fs --max-time 6 ifconfig.me 2>/dev/null || echo '本机IP')"
ENTRY="https://${1:-$PUBIP}/spectre/"
if [ "$TLS_OK" = yes ]; then
  TLS_NOTE="对外 TLS 就绪(https 入口; 无域名时证书为内部 CA——浏览器首访「高级→继续」, Caddy 已尝试把内部根装入系统信任库)"
else
  ENTRY="http://127.0.0.1:8081/spectre/"
  TLS_NOTE="对外 TLS 未就绪(journalctl -u spectre-caddy -n 20; 常见: 80/443 防火墙)——本机可先用上述入口"
fi
cat <<EOF

============================================================
 SPECTRE $([ "$TLS_OK" = yes ] && echo '就绪' || echo '核心就绪(TLS 未通)')
   入口   : $ENTRY
   账号   : admin  (密码: cat /root/spectre-admin-cred.txt)
   TLS    : $TLS_NOTE
   服务   : systemctl status spectre-{agent-runtime,console,caddy}
   可选   : 字典/指纹/jars 供给与技能种子见 deploy/README §6
            (bash deploy/fetch-wordlists.sh 等, 需 SPECTRE_DATA_DIR=$DATA_DIR)
============================================================
EOF
[ "$TLS_OK" = yes ] || exit 1
