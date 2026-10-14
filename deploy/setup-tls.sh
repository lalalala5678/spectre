#!/bin/bash
# setup-tls — SPECTRE 对外 TLS 一键装配(小白默认路径)
# 用法:
#   sudo bash deploy/setup-tls.sh your.domain.com   # 有域名→自动 Let's Encrypt
#   sudo bash deploy/setup-tls.sh                   # 无域名→探测公网 IP+内部 CA(浏览器首次访问须手动信任)
# 幂等: 重复运行只重写配置并 restart。
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
  echo '[setup-tls] 须 root 运行(sudo bash deploy/setup-tls.sh [域名])' >&2; exit 1
fi

DOMAIN="${1:-}"
INSTALL_DIR=/etc/spectre/caddy

# ---------- 1) Caddy 二进制: 已有→跳过; apt→静态官方包(保底) ----------
if ! command -v caddy >/dev/null 2>&1 && [ ! -x /usr/local/bin/caddy ]; then
  echo '[setup-tls] 安装 Caddy...'
  if ! (apt-get update -qq && apt-get install -y -qq caddy) >/dev/null 2>&1; then
    echo '[setup-tls] apt 无 caddy——落静态官方包'
    arch="$(dpkg --print-architecture 2>/dev/null || uname -m | sed 's/x86_64/amd64/')"
    ver="$(curl -fsSL --max-time 15 'https://api.github.com/repos/caddyserver/caddy/releases/latest' \
           | grep -oP '"tag_name":\s*"\K[^"]+' || true)"
    [ -n "$ver" ] || { echo '[setup-tls] FATAL: 无法取 Caddy 版本号(网络?)' >&2; exit 1; }
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/${ver}/caddy_linux_${arch}.tar.gz" \
      | tar -xz -C /usr/local/bin caddy
  fi
fi
CADDY="$(command -v caddy || echo /usr/local/bin/caddy)"
"$CADDY" version >/dev/null 2>&1 || { echo '[setup-tls] FATAL: caddy 二进制不可用' >&2; exit 1; }

# apt 自带的发行版 caddy.service 会抢占 80 与 admin 端口(:2019)——
# SPECTRE 用独立 spectre-caddy 单元, 发行版服务存在即停用(幂等)。
if systemctl is-active --quiet caddy 2>/dev/null; then
  echo '[setup-tls] 停用发行版 caddy.service(由 spectre-caddy 接管)'
  systemctl disable --now caddy >/dev/null 2>&1 || true
fi

# ---------- 2) 站点地址: 域名→自动 ACME; 无→全局地址枚举 + tls internal ----------
if [ -n "$DOMAIN" ]; then
  SITE="$DOMAIN"
  TLS_BLOCK='    # 自动 ACME(Caddy 缺省行为——80/443 须公网可达)'
else
  # 部署缺陷修复②: 此前仅取 ifconfig.me 单值——curl 出口偏 v6 时只签 v6,
  # 双栈机的公网 IPv4 入口无证书 → TLS 握手失败(实测)。改为枚举本机全部
  # 全局地址(v4 优先)再并出网探测 IP(NAT 场景保留旧行为), 去重后全部入签。
  echo '[setup-tls] 未传域名——枚举本机全局地址 + 出口 IP(内部 CA, 浏览器首次访问须手动信任)'
  IDS=""
  add_id() { case ",$IDS," in *",$1,"*) ;; *) IDS="${IDS:+$IDS,}$1" ;; esac; }
  while IFS= read -r a; do [ -n "$a" ] && add_id "$a"; done \
    < <(ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
  while IFS= read -r a; do [ -n "$a" ] && add_id "$a"; done \
    < <(ip -o -6 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
  OUT_IP="$(curl -fs --max-time 6 ifconfig.me 2>/dev/null || curl -fs --max-time 6 ip.sb 2>/dev/null || true)"
  [ -n "$OUT_IP" ] && add_id "$OUT_IP"
  [ -n "$IDS" ] || { echo '[setup-tls] FATAL: 未发现任何全局地址且出口探测失败——请手动传: sudo bash deploy/setup-tls.sh <域名或IP>' >&2; exit 1; }
  SITE="$IDS"
  TLS_BLOCK='    tls internal'
  IP_MODE=1
  echo "[setup-tls] 签发标识: $SITE"
fi
# Caddy 站点块多地址要求「逗号+空格」分隔(纯逗号 adapt 报错, 实测);
# 轮询/展示仍用纯逗号串(IFS 切分)。
SITE_CADDY="${SITE//,/, }"
# ---------- 3) 配置(网关保持 127.0.0.1:8081——安全侧默认不动) ----------
install -d -m 755 "$INSTALL_DIR"
cat > "$INSTALL_DIR/Caddyfile" <<EOF
{
	# admin 面错开 :2019(防与发行版实例冲突; reload 需要它在)
	admin 127.0.0.1:2020
}

# SPECTRE 对外 TLS(setup-tls.sh 生成; 手改后 systemctl restart spectre-caddy)
# 内部链路: Caddy :443 --TLS--> gateway 127.0.0.1:8081 -->> runtime :8090
$SITE_CADDY {
$TLS_BLOCK

	encode gzip
	reverse_proxy 127.0.0.1:8081

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Robots-Tag "noindex, nofollow"
	}
}
EOF

# ---------- 4) systemd 单元(独立 spectre-caddy, 不动发行版包) ----------
cat > /etc/systemd/system/spectre-caddy.service <<EOF
[Unit]
Description=SPECTRE TLS reverse proxy (Caddy)
After=network-online.target spectre-console.service
Wants=network-online.target

[Service]
Environment=HOME=/var/lib/spectre
ExecStart=$CADDY run --config $INSTALL_DIR/Caddyfile --adapter caddyfile
ExecReload=$CADDY reload --config $INSTALL_DIR/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# R32D100-F5: 公网面最小加固(证书/存储读写仅限数据根; 其余只读)。
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/spectre
ProtectHome=read-only
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable spectre-caddy >/dev/null 2>&1
systemctl restart spectre-caddy

# ---------- 5) 验证 + 下一步指引(R32D100-F3: 失败必须 exit 1) ----------
# 部署缺陷修复③: 此前 sleep 2 后单次 curl——内部 CA 首签常超 2s, 且裸
# IPv6 作 URL 主机是非法语法(需 [v6] 括号)——两因叠加把能成的部署误报
# FATAL(实测)。改为: 括号包裹 v6 + 轮询至多 30s, 逐标识探测。
tls_url() { case "$1" in *:*) echo "https://[$1]/spectre/" ;; *) echo "https://$1/spectre/" ;; esac; }
OK_ID=""
for _ in $(seq 1 15); do
  systemctl is-active --quiet spectre-caddy || { sleep 2; continue; }
  OLDIFS="$IFS"; IFS=','
  for id in $SITE; do
    if curl -fsk --max-time 4 "$(tls_url "$id")" -o /dev/null 2>/dev/null; then OK_ID="$id"; break; fi
  done
  IFS="$OLDIFS"
  [ -n "$OK_ID" ] && break
  sleep 2
done
if [ -n "$OK_ID" ]; then
  echo "[setup-tls] ✓ TLS 入口就绪: $(tls_url "$OK_ID") (全部标识: $SITE)"
  [ -n "${IP_MODE:-}" ] && echo '[setup-tls] 无域名模式: 内部 CA 证书——浏览器首访「高级→继续访问」; Caddy 已尝试把内部根装入系统信任库'
else
  echo '[setup-tls] FATAL: 自检未通(轮询 30s)——journalctl -u spectre-caddy -n 20; 常见: 80/443 防火墙或安全组未放行' >&2
  exit 1
fi
echo "[setup-tls] 浏览器访问 $(tls_url "$OK_ID") 并用 admin 登录(一键: 密码 cat /root/spectre-admin-cred.txt; 手工: spectre-passwd.py add 所设)"
