# 部署

完整部署 = 后端运行时 + 前端控制台 + 网关 + 可选基础设施（Temporal / OOB / Caddy / 私架面杀）。

## 组件清单

| 组件 | 入口 | 说明 |
|---|---|---|
| agent-runtime | `backend/agent-runtime.mjs` (:8090) | 14 智能体会话 + MCP 挂载 + 沙箱 |
| console | `console/` (vite build) | React 前端 |
| gateway | `gateway/server.py` (:8081) | 鉴权网关（登录 → runtime 反代） |
| worker | Temporal activities | engagement 批量调度（可选） |
| oob-collector | `deploy/oob-collector.py` (:19999) | 带外证据回收（可选） |
| private-qa | `deploy/systemd/spectre-private-qa.service` | 私架面杀端点（clamav+yara 真引擎） |

## 步骤

```bash
# 1) 后端
cd backend && cp .env.example .env && (填入 INTERNAL_TOKEN / LLM_API_KEY)
npm i && node agent-runtime.mjs

# 2) 前端
cd console && npm i && npm run build   # 产物交网关或静态服务

# 3) 网关
cd gateway && pip install -r requirements.txt 2>/dev/null || pip install fastapi uvicorn httpx
python3 server.py

# 4) systemd(宿主机, 按需)
sudo cp deploy/systemd/spectre-*.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now spectre-agent-runtime spectre-console

# 5) 沙箱容器(首次)
#    docker driver + 挂载 /opt/tools(见 backend/src/sandbox/container.mjs)
bash deploy/bootstrap-sandbox.sh      # 引擎/JDK/运行时 + 病毒库持久化
bash deploy/fetch-jars.sh             # 第三方 jar(40MB, 不入 git)

# 6) 数据源凭据
#    控制台「Agent 配置」页填入(验证通过才落盘; 爆破靶场见 docs/brute-skills/)
```

## 数据目录

运行时状态在 `/var/lib/spectre/`（WAL/会话/bus/MCP 配置），挂载进沙箱为 `/opt/tools`。工具链源码在本仓 `tools/`，部署时同步到该目录。

## 凭据边界

- `backend/.env` / `brutebench.env` / 病毒库 / 二进制 jar：均不入库（样例见对应 `.example` / 下载脚本）
