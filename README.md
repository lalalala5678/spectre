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
- **技能**：agentskills.io 格式，55 个方法论技能按智能体挂载

## 快速开始

```bash
git clone https://github.com/lalalala5678/spectre && cd spectre
cd backend && cp .env.example .env && npm i && node agent-runtime.mjs   # Node ≥ 20.19
cd ../console && npm i && npm run build                                 # Node ≥ 20.19
cd ../gateway && python3 spectre-passwd.py add admin && \
  SPECTRE_DATA_DIR=/tmp/spectre-data python3 server.py   # 纯 stdlib; 测试数据目录隔离
```

完整部署(systemd/沙箱/私架面杀/凭据边界)见 [deploy/README.md](deploy/README.md)。

数据源凭据在设置页配置（验证通过才落盘，未配置的源不注入智能体工具面）；LLM 凭据经 `backend/.env` 启动装载。

## 文档

`docs/` 含各阶段技能方法论、工具脚本与部署样例。`AGENTS.md` 是工具与智能体边界的完整设计规范。

## License

MIT
