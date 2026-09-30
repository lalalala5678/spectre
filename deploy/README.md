# 部署

完整部署 = 后端运行时 + 前端控制台 + 网关 + 可选基础设施（Temporal / OOB / Caddy / 私架面杀）。

## 环境要求

| 组件 | 要求 |
|---|---|
| Node | **前端 ≥ 20.19**（构建链 vite/rolldown 硬性）；后端 ≥ 18 即可 |
| Python | ≥ 3.6（网关零第三方依赖，纯 stdlib） |
| Docker | 仅沙箱 driver 需要 |

## 组件清单

| 组件 | 入口 | 默认端口 | 环境变量 |
|---|---|---|---|
| agent-runtime | `backend/agent-runtime.mjs` | 8090 | `PORT` `SPECTRE_DATA_DIR` `INTERNAL_TOKEN` `LLM_API_KEY` |
| console | `console/` (vite build) | — | — |
| gateway | `gateway/server.py` | 8081 | `GATEWAY_PORT` `RUNTIME_PORT` `GATEWAY_DIST_DIR` `SPECTRE_AUTH_DIR` `GATEWAY_LOG_DIR` `SPECTRE_DATA_DIR` |
| worker | Temporal activities | — | 同 runtime |
| oob-collector | `deploy/oob-collector.py` | 19999 | — |
| private-qa | `deploy/systemd/spectre-private-qa.service` | 8899 | — |

## 步骤

```bash
# 0) 获取与布局(任意目录皆可; systemd 部署建议 /opt/spectre)
git clone https://github.com/lalalala5678/spectre /opt/spectre && cd /opt/spectre

# 1) 后端
cd backend && cp .env.example .env   # 填 INTERNAL_TOKEN(自定义随机串) 与 LLM_API_KEY
npm i && node agent-runtime.mjs      # PORT/SPECTRE_DATA_DIR 可环境变量覆盖

# 2) 前端(Node ≥ 20.19)
cd ../console && npm i && npm run build

# 3) 网关(纯 stdlib, 无需 pip)
cd ../gateway
python3 spectre-passwd.py add admin          # 创建首个登录账号(交互输密码)
GATEWAY_DIST_DIR=../console/dist python3 server.py

# 4) 登录验证
#    浏览器打开 http://<host>:8081/spectre/ → admin 登录
#    Caddy/TLS 对外暴露时参考 deploy/Caddyfile

# 5) systemd(可选, 路径经环境文件驱动)
sudo mkdir -p /etc/spectre && sudo cp deploy/spectre.env.example /etc/spectre/spectre.env
#   按机修改 spectre.env(SPECTRE_REPO/NODE_BIN 等), 然后:
sudo cp deploy/systemd/spectre-*.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now spectre-agent-runtime spectre-console

# 6) 沙箱容器(可选; docker driver + /opt/tools 挂载, 见 backend/src/sandbox/container.mjs)
bash deploy/bootstrap-sandbox.sh      # 面杀引擎/JDK/运行时 + 病毒库持久化
bash deploy/fetch-jars.sh             # 第三方 jar(40MB, 不入 git)
bash deploy/tools-sync.sh             # 仓库工具链 → 运行时数据目录

# 7) 数据源凭据
#    控制台「Agent 配置」页填入(验证通过才落盘, 未配置不注入);
#    LLM 凭据在 backend/.env(启动必需)
```

## 账号管理

```bash
python3 gateway/spectre-passwd.py add <user>   # PASS=环境变量可非交互
python3 gateway/spectre-passwd.py del <user>
python3 gateway/spectre-passwd.py list
```

## 数据目录

运行时状态在 `$SPECTRE_DATA_DIR`(默认 `/var/lib/spectre/`)：WAL/会话/bus/MCP 配置，挂载进沙箱为 `/opt/tools`。

## 凭据边界（不入库）

`backend/.env` / `brutebench.env` / ClamAV 病毒库 / 第三方 jar —— 样例与获取脚本在仓（`.example` / `fetch-jars.sh`）。
