# 部署

完整部署 = 后端运行时 + 前端控制台 + 网关 + 可选基础设施（Temporal / OOB / Caddy / 私架面杀）。

## 环境要求

| 组件 | 要求 |
|---|---|
| Node | **≥ 22.19**（全仓统一：@earendil-works/* 依赖链 engines 下限） |
| Python | ≥ 3.7（网关零第三方依赖，纯 stdlib） |
| Docker | 沙箱 driver 需要——**装了 Docker 的机器上 runtime 启动即自动建沙箱容器+挂载(不装工具链——bootstrap 需手动执行)**; 设 `SPECTRE_SANDBOX_DRIVER=local` 可免 Docker 冒烟(工具链降级为宿主机直跑) |

> Node 22.x（<22.19）安装时 npm 会打出一墙 `EBADENGINE` 警告（@earendil-works/* 依赖链声明 22.19）——实测 22.14 安装与运行均正常，该警告可忽略。

> npm 故障排障: 安装若以 `npm error Exit handler never called!` 或 `ENOTFOUND mirrors.tencentyun.com` 等网络错误崩溃, 先 `npm config get registry` 检查是否指向不可达镜像; 切换 `--registry=https://registry.npmjs.org` 并**删除半装的 node_modules 后重装**。

## 组件清单

| 组件 | 入口 | 默认端口 | 环境变量 |
|---|---|---|---|
| agent-runtime | `backend/agent-runtime.mjs` | 8090 | `PORT` `SPECTRE_DATA_DIR` `INTERNAL_TOKEN` `LLM_API_KEY` `SPECTRE_SANDBOX_DRIVER` |
| console | `console/` (vite build) | — | — |
| gateway | `gateway/server.py` | 8081 | `GATEWAY_BIND_HOST` `GATEWAY_PORT` `RUNTIME_HOST` `RUNTIME_PORT` `GATEWAY_DIST_DIR` `SPECTRE_AUTH_DIR` `GATEWAY_LOG_DIR` `SPECTRE_DATA_DIR` `INTERNAL_TOKEN`(与 backend 同值, API 反代必需) `GATEWAY_INSECURE_COOKIE`(仅纯 HTTP 测试) `GATEWAY_TRUST_PROXY`(直连公网时置 0) |
| worker | Temporal activities | — | 同 runtime |
| oob-collector | `deploy/oob-collector.py` | 19999 | `OOB_PORT` `SPECTRE_DATA_DIR` |
| private-qa | `deploy/systemd/spectre-private-qa.service` | 8899 | — |

## 步骤

```bash
# 0) 获取与布局(任意目录皆可; systemd 部署建议 /opt/spectre)
git clone https://github.com/lalalala5678/spectre /opt/spectre && cd /opt/spectre

# 1) 后端(state.wal 属主——多实例共用数据目录会互相覆写, 测试务必隔离)
cd backend && cp .env.example .env   # 填 INTERNAL_TOKEN(自定义随机串) 与 LLM_API_KEY
SPECTRE_DATA_DIR=/tmp/spectre-data npm i
SPECTRE_DATA_DIR=/tmp/spectre-data node agent-runtime.mjs   # PORT 可覆盖; 生产缺省 /var/lib/spectre

# 2) 前端(Node ≥ 22)
cd ../console && npm i && npm run build

# 3) 网关(纯 stdlib, 无需 pip; Python ≥ 3.7)
#    共享机/生产机测试: 加 SPECTRE_AUTH_DIR=<隔离目录> GATEWAY_LOG_DIR=<隔离目录> 前缀
cd ../gateway
# 建号与网关必须同一 SPECTRE_AUTH_DIR(env 前缀不穿透 &&——export 后两段共用)
export SPECTRE_AUTH_DIR=/var/lib/spectre/auth
python3 spectre-passwd.py add admin           # 交互输密码
export INTERNAL_TOKEN=<与 backend/.env 同值>   # 网关反代 API 的令牌
export SPECTRE_DATA_DIR=/tmp/spectre-data      # 与后端①同目录即可(网关只写会话文件)
python3 server.py                             # dist 默认 ../console/dist

# 4) 登录验证
#    本机: http://127.0.0.1:8081/spectre/ → admin 登录
#    远程纯 HTTP: cookie 带 Secure 位会静默无法登录——要么 GATEWAY_INSECURE_COOKIE=1(仅测试),
#    要么经 TLS(Caddy 样例见 deploy/Caddyfile; 网关默认只绑 127.0.0.1, 远程需 GATEWAY_BIND_HOST 或隧道)
#    注意: 前端 npm i 与 npm run build 需同一 Node ≥ 22(混版本装出的原生依赖会损坏)

# 5) systemd(可选, 路径经环境文件驱动)
sudo mkdir -p /etc/spectre && sudo cp deploy/spectre.env.example /etc/spectre/spectre.env
#   按机修改 spectre.env(SPECTRE_REPO/NODE_BIN 等), 然后:
sudo cp deploy/systemd/spectre-*.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now spectre-agent-runtime spectre-console

# 6) 沙箱容器(可选; docker driver + /opt/tools 挂载, 见 backend/src/sandbox/container.mjs)
export SPECTRE_DATA_DIR=${SPECTRE_DATA_DIR:-/var/lib/spectre}   # 四脚本统一数据根
bash deploy/tools-sync.sh             # 仓库工具链+引导脚本 → 数据根(先行: 交付容器内引导)
# 容器名按数据根哈希精确派生(共享机勿盲打缺省名——隔离实例是
# spectre-sbx-<sha256(数据根)前8位>, 缺省数据根才是 spectre-sandbox)
SBX="spectre-sbx-$(printf %s "$SPECTRE_DATA_DIR" | sha256sum | cut -c1-8)"
docker exec "$SBX" bash /opt/tools/bootstrap-sandbox.sh \
  || { echo "容器 $SBX 不存在(runtime 未起?)——docker ps 查实际名; 缺省数据根为 spectre-sandbox" >&2; exit 1; }
bash deploy/fetch-jars.sh             # 第三方 jar(~25MB, 不入 git; 落 $SPECTRE_DATA_DIR/tools/c2)
PORT=18090 INTERNAL_TOKEN=<同 backend/.env 值> bash deploy/skills-seed.sh  # 55 技能; 即时刷新需两变量与 runtime 同源(缺省回落 8090)

# 7) 数据源凭据
#    控制台「Agent 配置」页填入(验证通过才落盘, 未配置不注入);
#    LLM 凭据在 backend/.env(启动必需)
```

## 账号管理

```bash
# 共享机: 所有命令加 SPECTRE_AUTH_DIR=<隔离目录> 前缀(list 也会读缺省生产文件)
SPECTRE_AUTH_DIR=<隔离目录> python3 gateway/spectre-passwd.py add <user>   # PASS=环境变量可非交互
SPECTRE_AUTH_DIR=<隔离目录> python3 gateway/spectre-passwd.py del <user>
SPECTRE_AUTH_DIR=<隔离目录> python3 gateway/spectre-passwd.py list
curl 集成: 登录 POST 字段为 `user`/`pw`——`curl -d 'user=admin&pw=...' http://<gw>:8081/spectre/login`。
```

## Temporal(可选编排链)

worker/AutoPwn 战役调度依赖 Temporal server; 未安装时 worker 静默重试、
战役发起时才失败。单机开发用 server-dev:

```bash
# temporal CLI(任一): brew install temporal / 或从 github.com/temporalio/cli/releases 下载
temporal server start-dev --port 7233    # 前台; systemd 部署用 deploy/systemd/temporal-dev.service
```

步骤 5 systemd 全家桶: `sudo systemctl enable --now spectre-agent-runtime spectre-console temporal-dev spectre-worker spectre-oob`。

## 手工运行 oob-collector

```bash
OOB_PORT=19999 SPECTRE_DATA_DIR=/var/lib/spectre python3 deploy/oob-collector.py
```

两个变量显式带上——缺省数据根即生产路径, 测试时务必指向隔离目录。
语义: 裸 TCP 字节收集器非 HTTP——curl 探测会挂起(属预期), 测试用 `nc 127.0.0.1 <port>` 或 `/dev/tcp`。

## 行为备注

- API 裸建会话(无 workSessionId)不进项目历史列表——顶部全局搜索按标题/ID 可找回; UI 建会自动归组
- POST /api/sessions 的 title 字段被忽略——标题由 summarizer 在首轮对话后自动生成(设计)
- 登录后 UI 会在最近工作会话自动创建 AutoPwn 会话(编排器常驻入口)
- 登录失败锁定为网关内存态(5 次/15 分钟, 重启即清); 登录成败同为 303, CLI 集成读 Location 的 `?e=` 参数(`e=cred`/`e=lock`)区分

## API 认证

runtime 全部 `/api/*`(除 `/api/health`)要求头 `X-Internal-Token: <INTERNAL_TOKEN 值>`(网关自动注入; 直连时自带; Bearer 不支持)。

## CLI 验证备注

`/api/bus/events` 为 SSE 长连接(空闲仅心跳)——CLI 探测用 `curl -N --max-time 3`, 裸 curl 会挂起属预期。

## 数据目录

运行时状态在 `$SPECTRE_DATA_DIR`(默认 `/var/lib/spectre/`)：WAL/会话/bus/MCP 配置，挂载进沙箱为 `/opt/tools`。

## 凭据边界（不入库）

`backend/.env` / `brutebench.env` / ClamAV 病毒库 / 第三方 jar —— 样例与获取脚本在仓（`.example` / `fetch-jars.sh`）。
