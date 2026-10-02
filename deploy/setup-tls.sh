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

# ---------- 2) 站点地址: 域名→自动 ACME; 无→公网 IP + tls internal ----------
if [ -n "$DOMAIN" ]; then
  SITE="$DOMAIN"
  TLS_BLOCK='    # 自动 ACME(Caddy 缺省行为——80/443 须公网可达)'
else
  echo '[setup-tls] 未传域名——探测公网 IP(内部 CA, 浏览器首次访问须手动信任)'
  DOMAIN="$(curl -fs --max-time 6 ifconfig.me 2>/dev/null || curl -fs --max-time 6 ip.sb 2>/dev/null || true)"
  [ -n "$DOMAIN" ] || { echo '[setup-tls] FATAL: 探测公网 IP 失败——请手动传: sudo bash deploy/setup-tls.sh <域名或IP>' >&2; exit 1; }
  # IP 作站点地址(tls internal 为其发 IP SAN 证书; 无主机名的 :443
  # 无证书可发→握手 internal error, 实测)。
  SITE="$DOMAIN"
  TLS_BLOCK='    tls internal'
  IP_MODE=1
fi

# ---------- 3) 配置(网关保持 127.0.0.1:8081——安全侧默认不动) ----------
install -d -m 755 "$INSTALL_DIR"
cat > "$INSTALL_DIR/Caddyfile" <<EOF
{
	# admin 面错开 :2019(防与发行版实例冲突; reload 需要它在)
	admin 127.0.0.1:2020
}

# SPECTRE 对外 TLS(setup-tls.sh 生成; 手改后 systemctl restart spectre-caddy)
# 内部链路: Caddy :443 --TLS--> gateway 127.0.0.1:8081 -->> runtime :8090
$SITE {
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

# ---------- 5) 验证 + 下一步指引(R32D100-F3: 失败必须 exit 1+单元活性双查) ----------
sleep 2
FAIL=0
systemctl is-active --quiet spectre-caddy || FAIL=1
if [ "$FAIL" = 0 ] && { curl -fsk --max-time 8 "https://${DOMAIN}/spectre/" -o /dev/null 2>/dev/null \
   || curl -fsk --max-time 8 "https://127.0.0.1/spectre/" -o /dev/null 2>/dev/null; }; then
  echo "[setup-tls] ✓ TLS 入口就绪: https://${DOMAIN}/spectre/"
  [ -n "${IP_MODE:-}" ] && echo '[setup-tls] 无域名模式: 内部 CA 证书——浏览器首访「高级→继续访问」; Caddy 已尝试把内部根装入系统信任库'
else
  echo '[setup-tls] FATAL: 自检未通——journalctl -u spectre-caddy -n 20; 常见: 80/443 防火墙或安全组未放行' >&2
  exit 1
fi
echo "[setup-tls] 浏览器访问 https://${DOMAIN}/spectre/ 并用 admin 登录(密码=spectre-passwd.py add 所设)"
