#!/bin/bash
# 沙箱容器初始化 —— 在 spectre-sandbox 容器内执行!
# 警告: 直接在宿主机运行会 apt 安装系统级包(需 root 且改动宿机)——
# 除非你明确要裸机部署, 否则经 docker exec / API 通道派发。
# 幂等: 重复执行安全; 安装账本(install-log)由平台 installCli 通道自动维护
set -e

echo "[bootstrap] 系统包(面杀引擎+JDK+运行时)"
apt-get update -qq
apt-get install -y -qq clamav yara openjdk-17-jdk-headless \
  nodejs npm python3-pip git curl unzip jq build-essential php-cli

echo "[bootstrap] ClamAV 病毒库 → 持久挂载(容器重建不重下)"
mkdir -p /opt/tools/c2/clamav-db
chown -R "$(id -u clamav 2>/dev/null || echo 103):$(id -g clamav 2>/dev/null || echo 106)" /opt/tools/c2/clamav-db
if [ ! -L /var/lib/clamav ]; then
  rm -f /var/lib/clamav/clamav-db
  mv /var/lib/clamav/* /opt/tools/c2/clamav-db/ || echo "[bootstrap] 库搬迁部分失败(已有库? 继续)"
  rmdir /var/lib/clamav 2>/dev/null
  ln -sn /opt/tools/c2/clamav-db /var/lib/clamav
fi
freshclam || echo "[bootstrap] freshclam 失败(离线?)——已有库可继续"

echo "[bootstrap] Python 工具依赖"
pip3 install --quiet --break-system-packages pyyaml || pip3 install --quiet pyyaml

echo "[bootstrap] 完成。工具链见 /opt/tools/bin, 引擎矩阵: c2-qa.py scan --engines auto"
