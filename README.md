# SPECTRE

多智能体渗透测试平台。14 个阶段智能体 + MCP 工具面 + Temporal 工作流，从资产测绘到报告交付全链路闭环。

## 界面

![console](console/screenshots/autopwn-full.png)

## 架构

```
┌─ console (React) ─── 网关(Python) ── agent-runtime (Node, :8090)
│                                        ├─ 14 会话智能体(GLM/pi-agent-core)
│                                        ├─ MCP stdio 服务器群(recon/nday 情报源)
│                                        └─ 沙箱(docker driver, CLI/skills 挂载)
├─ worker (Temporal activities) ── temporal-dev
└─ oob-collector (:19999) / Caddy TLS
```

**智能体**：autopwn(编排) · recon(资产测绘) · nday(NDay) · weakcred(爆破) · api(API 渗透) · exploit(漏洞挖掘) · phish(钓鱼) · c2(C2/内存马) · persistence(权限维持) · postex(后渗透) · report(报告) · skill-config / mcp-config / cli-config(配置三键)

**数据流**：智能体产出 → bus 事件流(漏洞/情报/任务报告, append-only 修订链) → 前端面板；每变异 WAL 落盘，重启零丢失。

## 工具面

- **MCP**：recon-datasources(fofa/quake/hunter/zoomeye/censys/shodan/github/cse/ipinfo/threatbook)、nday-intel(nvd_cve)、自定义 server 热挂载
- **共享工具独立实例**：每智能体各持 search_web / fetch_url(垂直通道零 key + 可选 provider 兜底)
- **沙箱 CLI**：c2-qa(多引擎面杀矩阵+私架端点)、c2-variant/functest/bind(载荷流水线)、nuclei/hydra/nmap 等(安装账本化，容器重建自动重放)
- **技能**：agentskills.io 格式（SKILL.md），按智能体分组挂载于 docs/*-skills/

## 环境要求

- Node ≥ 22(获取: `nvm install 22` 或 [NodeSource](https://github.com/nodesource/distributions); 22.19+ 零依赖警告); Python ≥ 3.7; Docker 可选(沙箱)

## 快速开始

```bash
git clone https://github.com/lalalala5678/spectre && cd spectre

# ① 后端(Node ≥ 22)——先编辑 .env 填 INTERNAL_TOKEN(自定随机串)与 LLM_API_KEY
cd backend && cp .env.example .env && ${EDITOR:-vi} .env
SPECTRE_DATA_DIR=/tmp/spectre-data npm i && npm test && \
SPECTRE_DATA_DIR=/tmp/spectre-data node agent-runtime.mjs   # npm 崩溃→deploy/README 排障节   # 测试隔离数据目录(生产缺省 /var/lib/spectre)

# ② 前端(Node ≥ 22; 与 ① 同一 Node 版本)
cd ../console && npm i && npm run build  # npm 崩溃(Exit handler/ENOTFOUND)→ deploy/README 排障节

# ③ 网关(纯 stdlib)——INTERNAL_TOKEN 必须=① 中 .env 的值, 否则 API 反代全 401
cd ../gateway && SPECTRE_AUTH_DIR=/tmp/spectre-auth PASS='<密码>' \
  python3 spectre-passwd.py add admin && \
  INTERNAL_TOKEN=<同①> SPECTRE_DATA_DIR=/tmp/spectre-data \
  SPECTRE_AUTH_DIR=/tmp/spectre-auth GATEWAY_LOG_DIR=/tmp/spectre-logs \
  python3 server.py   # env 前缀不穿透 && ——每段都要带 SPECTRE_AUTH_DIR
```

打开 `http://127.0.0.1:8081/spectre/` 用 admin 登录。远程纯 HTTP 需 `GATEWAY_INSECURE_COOKIE=1`（仅测试；生产走 TLS）。

> Node 22.x(低于 22.19)安装时 npm 会打印 EBADENGINE 警告——依赖链的版本声明比实际需求严格, 22.x 实测可运行, 警告可忽略。

共享机多实例: 所有服务统一加 `PORT/GATEWAY_PORT/SPECTRE_DATA_DIR/SPECTRE_AUTH_DIR/TEMPORAL_ADDRESS` 隔离前缀(worker 默认连 7233 生产队列)。

完整部署(systemd/沙箱/私架面杀/凭据边界)见 [deploy/README.md](deploy/README.md)。

数据源凭据在设置页配置（验证通过才落盘，未配置的源不注入智能体工具面）；LLM 凭据经 `backend/.env` 启动装载。

## 文档

`docs/` 含各阶段技能方法论、工具脚本与部署样例。`AGENTS.md` 是工具与智能体边界的完整设计规范。

## License

MIT
