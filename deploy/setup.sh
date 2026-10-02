#!/bin/bash
# setup — SPECTRE 一键部署(小白默认路径): 依赖→构建→账号→systemd→对外 TLS
# 用法:
#   sudo bash deploy/setup.sh              # 全默认(公网 IP + 内部 CA 证书)
#   sudo bash deploy/setup.sh your.domain.com   # 有域名→自动 Let's Encrypt
# 幂等: 重复运行安全(已装步骤跳过/接管)。
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  echo '[setup] 须 root 运行: sudo bash deploy/setup.sh [域名]' >&2; exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR=/var/lib/spectre
AUTH_DIR=/etc/spectre-auth
say() { echo "[setup] $*"; }

# ---------- 1) Node ≥22(缺则 NodeSource 装) ----------
NODE_OK="$(node -v 2>/dev/null | grep -oP '\d+' | head -1 || echo 0)"
if [ "${NODE_OK:-0}" -lt 22 ]; then
  say '安装 Node 22(NodeSource)...'
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
say "Node: $($NODE_BIN -v)"

# ---------- 2) 后端依赖 + .env(first-wins: 不覆盖已有) ----------
cd "$REPO/backend"
[ -f .env ] || cp .env.example .env
if grep -q '^INTERNAL_TOKEN=change-me' .env 2>/dev/null || ! grep -q '^INTERNAL_TOKEN=' .env; then
  TOK="$(openssl rand -hex 32)"
  sed -i "s|^INTERNAL_TOKEN=.*|INTERNAL_TOKEN=$TOK|" .env
  say '已生成 INTERNAL_TOKEN(backend/.env)'
fi
npm install --no-audit --no-fund --silent

# ---------- 3) 前端构建 ----------
cd "$REPO/console"
npm install --no-audit --no-fund --silent
npm run build --silent
[ -f "$REPO/console/dist/index.html" ] || { say 'FATAL: 前端构建产物缺失'; exit 1; }

# ---------- 4) admin 账号(已存在则跳过) ----------
install -d -m 750 "$AUTH_DIR"
if [ ! -f "$AUTH_DIR/passwd" ]; then
  PW="Spectre-$(openssl rand -hex 4)-Admin"
  SPECTRE_AUTH_DIR="$AUTH_DIR" PASS="$PW" python3 "$REPO/gateway/spectre-passwd.py" add admin >/dev/null 2>&1
  echo "$PW" > /root/spectre-admin-cred.txt && chmod 600 /root/spectre-admin-cred.txt
  say "admin 账号已建, 密码已存 /root/spectre-admin-cred.txt"
fi

# ---------- 5) systemd 环境文件 + 单元 ----------
TOK="$(grep -oP '^INTERNAL_TOKEN=\K.*' "$REPO/backend/.env")"
install -d -m 755 /etc/spectre
cat > /etc/spectre/spectre.env <<EOF
SPECTRE_REPO=$REPO
SPECTRE_DATA_DIR=$DATA_DIR
NODE_BIN=$NODE_BIN
INTERNAL_TOKEN=$TOK
GATEWAY_DIST_DIR=$REPO/console/dist
EOF
install -d -m 755 "$DATA_DIR"
cp "$REPO"/deploy/systemd/spectre-*.service /etc/systemd/system/
# 接管本脚本外的手工实例(占 8090/8081/19999 时)
pkill -f "$REPO/backend/agent-runtime.mjs" 2>/dev/null || true
pkill -f 'agent-runtime.mjs' 2>/dev/null || true
pkill -f "$REPO/gateway/server.py" 2>/dev/null || true
pkill -f 'gateway/server\.py' 2>/dev/null || true
pkill -f 'oob-collector\.py' 2>/dev/null || true
sleep 1
systemctl daemon-reload
systemctl enable --now spectre-agent-runtime spectre-console >/dev/null 2>&1
systemctl restart spectre-agent-runtime spectre-console
sleep 2
systemctl is-active --quiet spectre-agent-runtime spectre-console \
  || { say 'FATAL: runtime/console 单元未活——journalctl -u spectre-agent-runtime -n 20'; exit 1; }
say 'runtime(8090) + 网关(8081) 已由 systemd 托管'

# ---------- 6) 对外 TLS(默认自动化; 域名透传) ----------
bash "$REPO/deploy/setup-tls.sh" "${1:-}"

# ---------- 7) 收尾指引 ----------
PUBIP="$(curl -fs --max-time 6 ifconfig.me 2>/dev/null || echo '本机IP')"
cat <<EOF

============================================================
 SPECTRE 就绪
   入口   : https://${1:-$PUBIP}/spectre/
   账号   : admin  (密码: cat /root/spectre-admin-cred.txt)
   服务   : systemctl status spectre-{agent-runtime,console,caddy}
   可选   : 字典/指纹/jars 供给与技能种子见 deploy/README §6
            (bash deploy/fetch-wordlists.sh 等, 需 SPECTRE_DATA_DIR=$DATA_DIR)
============================================================
EOF
