<div align="center">

# SPECTRE

### 给它一个目标， 它还你一份渗透报告

**多智能体渗透测试平台** —— 11 个专职智能体协同作战, 你只需要按两次"批准"

[![GitHub Stars](https://img.shields.io/github/stars/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/stargazers)
[![GitHub Watchers](https://img.shields.io/github/watchers/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/watchers)
[![GitHub Forks](https://img.shields.io/github/forks/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/pulls)

[![GitHub License](https://img.shields.io/github/license/lalalala5678/spectre?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.4.0-blue.svg?style=flat-square)](https://github.com/lalalala5678/spectre/releases)
[![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white)](./deploy/README.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./backend/package.json)

[English](./README_EN.md) | [中文文档](./README.md)

![console](console/screenshots/autopwn-full.png)

</div>

---

## 一场战役长什么样

你输入:`对 127.0.0.1:30080 的 Juice Shop 进行渗透测试`

接下来不需要你做任何事:

1. **测绘** —— recon 智能体扫出 60+ 端点、技术栈、隐藏目录、内网拓扑
2. **要授权** —— 目标不在授权清单, 平台弹一次确认卡, 你点"批准"(**这是你仅有的两次点击之一**)
3. **集团作战** —— recon 继续测绘的同时, weakcred 爆破弱口令、api 铺越权矩阵、exploit 构造利用链、nday 对账 CVE, 全部并行
4. **独立复核** —— 每一条漏洞线索, 都由**独立的报告智能体重新验证一遍**才允许入库——AI 找到的洞, 再由 AI 自己证伪一遍
5. **交付** —— 带完整证据链、POC、杀伤链、负空间清单的终报入库, 你点开看结果(**第二次点击**)

一场 Juice Shop 战役的实际产出: **22 项漏洞发现, 其中 3 个 critical**(SQL 注入认证绕过 / JWT 无凭据伪造管理员 / 任意文件读取), 官方 116 项挑战被触发 24 项。全程零人工干预。

> 看一份真实终报(脱敏): [docs/samples/sample-report.md](docs/samples/sample-report.md)

## 实战战绩

平台开发期间, 用五场公开靶场战役做了全链路实测——**每一场都是智能体自主打完, 人类只批准授权**:

| 战役 | 目标类型 | 漏洞发现 | 亮点 |
|---|---|---|---|
| crAPI v1.1.5 | 现代 API 栈(Spring/Node/Mongo) | **30 项**(7 critical) | 5 条完整杀伤链, MySQL/PG 默认凭据直连全库沦陷 |
| WebGoat 8 | Java/Spring 企业课目 | **29 项正本** | JWT 五重伪造、XXE、SQLi 全覆盖, 12/12 课目 |
| vAPI | PHP/MySQL, OWASP API Top10 | **19 项** | 13/13 课目全打透, API Token 离线伪造全库接管 |
| Juice Shop 20 | Node/Angular 电商 | **22 项**(3 critical) | 官方 116 挑战触发 24, 反序列化 RCE 前置链闭合 |
| DVWA | PHP 经典全课目 | **16 项** | 14/14 模块, 双通道 webshell 权限维持 |

五场合计 **116 项漏洞发现**, 每一项都有 POC、证据链、独立复核记录, 可在情报库中逐条回溯。

## 六个它和"单挑一个 ChatGPT"不一样的地方

**1. 11 个专家, 不是一个模型装 11 次**

recon、weakcred、api、exploit、persistence、postex…… 每个席位有自己的工具链、技能库和提示词——爆破席跑字典、API 席铺越权矩阵、利用席构造链, 像一支真实的红队。编排智能体负责调度与对账, 不越俎代庖。

**2. AI 找的洞, AI 自己再证伪一遍**

所有漏洞线索必须经**独立报告智能体**复核: 重新读上下文、复现证据、对照库内已有发现——成立才落账, 重复则合并, 不成立直接驳回并说明理由。这是对"AI 渗透=幻觉大礼包"质疑的直接回答。

**3. 授权是流程, 不是牢笼**

目标在授权清单内, 智能体全程不被打扰; 不在清单, 首次触达提示申请, 你批一次, 全项目即时生效。平台**不做代码级硬拦**——但每一次命令、每一个事件都进 append-only 审计链, 事后逐条可追。

**4. 进程死了, 战役不死**

预写日志每变异落盘, 重启零丢失; 部署重启先排空在飞回合再退出; 智能体回合被腰斩(断电/崩溃), 重启后自动检测并从断点续跑; 模型接口限速, 45-60 秒退避自动重试。这些不是愿景, 每一条都是修过真实事故之后落下的机制。

**5. 全栈审计回放**

每条命令、每次工具调用、每个 DM、每轮思考, 全部落入事件总线并可在前端时间线回放。漏洞报告带修订链(谁改的、为什么、何时), 情报库 append-only 不可篡改。

**6. 模型随便换**

OpenAI 兼容 / Anthropic / Gemini 三种线制, 登录后在设置页填四个字段即可, 保存前平台用真实请求探测连通性。支持默认模型 + 单席位覆盖(比如报告席换更严谨的模型)。

## 架构一屏

```
┌─ console (React) ── 网关 (Python) ── agent-runtime (Node)
│                                      ├─ 11 业务智能体 + 3 配置智能体 (pi-agent-core)
│                                      ├─ MCP 情报源: fofa/quake/hunter/zoomeye/censys/shodan...
│                                      └─ Docker 沙箱: nuclei/hydra/nmap, 容器级隔离
├─ Temporal 工作流 ── 战役调度/断点续跑/代拟收尾
└─ OOB 收集器 (:19999) ── 带外判收, 沙箱直读实收
```

<details>
<summary><b>智能体席位一览</b></summary>

| 席位 | 职责 |
|---|---|
| autopwn | 编排: 分解目标、调度席位、对账产出 |
| recon | 资产测绘: 端口、路由、技术栈、内网拓扑 |
| nday | NDay 验证: CVE 对账、模板匹配、变体绕过 |
| weakcred | 弱口令: 字典爆破、凭据复用、喷洒 |
| api | API 渗透: 越权矩阵、批量赋值、JWT |
| exploit | 漏洞挖掘与利用链构造 |
| phish | 钓鱼: 模板、落地页、凭据回收 |
| c2 | 命令通道注册与生命周期 |
| persistence | 权限维持: 冗余通道、拟态伪装 |
| postex | 后渗透: 取证、横向面测绘 |
| report | 报告: 独立复核每条线索, 立账/合并/驳回 |

配置三键(skill/mcp/cli-config)持有全部配置工具, 业务席位永不被配置提示词污染。

</details>

## 快速开始

```bash
git clone https://github.com/lalalala5678/spectre && cd spectre
sudo bash deploy/setup.sh    # 带域名: sudo bash deploy/setup.sh your.domain.com
```

一条命令: 依赖构建、admin 建号、systemd 服务、TLS 对外暴露。跑起来后打开控制台, 配置任意 OpenAI 兼容模型, 输入一个目标——看它自己打。

> ⚠️ 一键脚本整机独占(8090/8081/443 + /etc/spectre); 共享机走 [手工路径](#手工部署)。

<details>
<summary><b>手工部署</b>(共享机 / 排障)</summary>

```bash
# ① 后端 (Node ≥ 22)
cd backend && cp .env.example .env   # INTERNAL_TOKEN 填随机串(删占位行)
SPECTRE_DATA_DIR=/tmp/spectre-data npm i && npm test
SPECTRE_DATA_DIR=/tmp/spectre-data node agent-runtime.mjs

# ② 前端
cd ../console && npm i && npm run build

# ③ 网关 (纯 stdlib)
cd ../gateway
SPECTRE_AUTH_DIR=/tmp/spectre-auth PASS='<密码>' python3 spectre-passwd.py add admin
INTERNAL_TOKEN=<同①> SPECTRE_DATA_DIR=/tmp/spectre-data \
  SPECTRE_AUTH_DIR=/tmp/spectre-auth python3 server.py
```

打开 `http://127.0.0.1:8081/spectre/`, admin 登录, 设置页配模型。

</details>

## 常见疑问

**AI 找的漏洞可信吗?**
每条线索由独立报告席位复核(读原文、复现证据、对照库内), 成立才落账; 我们的五场战役里它也驳回过自己人的误报。终报里的每条漏洞都带 POC 和证据链, 你可以逐条复验。

**会不会打没授权的目标?**
授权清单外的目标首次触达时会向你要授权, 不批就不打; 批了全程记录。平台不硬拦(那会拖慢节奏), 但审计链保证任何动作可追溯——越界的责任界面清晰。

**断了/崩了/限速了怎么办?**
见"六个不一样"第 4 条——这三种死法各有对应的自动恢复机制, 都是真实事故修出来的。

**能接我自己的模型吗?**
能, 任意 OpenAI 兼容/Anthropic/Gemini 线制, 设置页四个字段, 保存前真实探测。

## 贡献与支持

- Bug / 功能建议: [提 Issue](https://github.com/lalalala5678/spectre/issues), 附复现步骤与日志片段
- PR: 改动触及核心文件请同步 `docs/ARCHITECTURE.md` 行数表(测试会锁), 跑通 `cd backend && npm test`
- 安全披露: 走私下渠道, 勿在公开 issue 贴未脱敏凭据

## 合规声明

SPECTRE 仅用于**已获书面授权**的渗透测试。平台内置授权清单与全程审计, 但合规责任在使用者——对未授权目标发起测试的一切后果与本项目无关。

## License

[MIT](./LICENSE) © 2026 lalalala5678
