<div align="center">

# SPECTRE

### 给它一个目标， 它还你一份渗透报告

**多智能体渗透测试平台** —— 11 个专职智能体红队、独立复核防幻觉、全程审计可回放。你只需要按两次"批准"。

[![GitHub Stars](https://img.shields.io/github/stars/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/stargazers)
[![GitHub Watchers](https://img.shields.io/github/watchers/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/watchers)
[![GitHub Forks](https://img.shields.io/github/forks/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/pulls)

[![GitHub License](https://img.shields.io/github/license/lalalala5678/spectre?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.4.0-blue.svg?style=flat-square)](https://github.com/lalalala5678/spectre/releases)
[![Tests](https://img.shields.io/badge/tests-65%20passing-brightgreen?style=flat-square)](#测试)
[![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white)](./deploy/README.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./backend/package.json)

[English](./README_EN.md) | [中文文档](./README.md)

![console](console/screenshots/autopwn-full.png)

</div>

---

## 一场战役长什么样

你输入:`对 127.0.0.1:30080 的 Juice Shop 进行渗透测试`

之后不需要你做任何事:

1. **测绘** —— recon 席位扫出 60+ 端点、技术栈、隐藏目录、内网拓扑,产出中段情报实时入库
2. **要授权** —— 目标不在授权清单, 平台弹一次确认卡, 你点"批准"(**你仅有的两次点击之一**)
3. **集团作战** —— 测绘继续的同时, weakcred 爆破弱口令、api 铺越权矩阵、exploit 构造利用链、nday 对账 CVE——席位间自动共享情报, 不重复劳动
4. **独立复核** —— 每条漏洞线索交由**独立报告席位**重新验证: 复现证据、读全文、对照库内——成立才落账, 重复则合并, 不成立驳回并写明理由。**发现漏洞的 AI 不是判定漏洞的 AI**
5. **交付** —— 带证据链、POC、杀伤链、负空间清单的终报入库, 你点开看结果(**第二次点击**)

这场 Juice Shop 战役的实际产出: **22 项发现, 3 个 critical**(SQLi 认证绕过 / JWT 无凭据伪造管理员 / 任意文件读取), 官方 116 项挑战触发 24 项。

> 看一份真实终报(脱敏): [docs/samples/sample-report.md](docs/samples/sample-report.md)

## 实战战绩

五场公开靶场战役, **全部由智能体自主完成, 人类只批准授权**:

| 战役 | 目标栈 | 发现 | 亮点 |
|---|---|---|---|
| crAPI v1.1.5 | Spring / Node / Mongo / PG | **30 项**(7 crit) | 5 条完整杀伤链; 默认 DB 凭据 → 全库沦陷 |
| WebGoat 8 | Java / Spring | **29 项** | JWT 五重伪造、XXE、SQLi; 12/12 课目 |
| vAPI | PHP / MySQL, OWASP API Top10 | **19 项** | 13/13 课目; API Token 离线伪造 → 全库接管 |
| Juice Shop 20 | Node / Angular | **22 项**(3 crit) | 24/116 官方挑战; 反序列化 RCE 链闭合 |
| DVWA | PHP 经典 | **16 项** | 14/14 模块; 双通道 webshell 权限维持 |

**合计 116 项**, 每项带 POC、证据链、独立复核记录——在情报库逐条可回溯。

## 为什么不是"一个 ChatGPT 套壳"

**11 个专家, 各有各的武器库。** 每个席位持独立工具链与技能集: 爆破席跑字典、API 席铺矩阵、利用席构造链、取证席做后渗透——像一支真实红队。编排席位负责调度与对账, 不越俎代庖。

**AI 找的洞, AI 自己再证伪一遍。** 独立报告席位复核每条线索(读原文/复现证据/查库), 五场战役里它也驳回过自己人的误报。对"AI 渗透=幻觉大礼包"的直接回答。

**授权是流程, 不是牢笼。** 清单内目标全程零打扰; 清单外首次触达申请, 批一次全席位即时生效(流式回合走即时转向注入)。平台不硬拦, 但每条命令进 append-only 审计链——越界动作 100% 可追溯。

**进程死了, 战役不死。** 这些不是宣传语, 是真实事故修出来的机制(见下方[可靠性工程](#可靠性工程))。

**模型随便换。** OpenAI 兼容 / Anthropic / Gemini, 设置页四字段, 保存前真实探测连通; 支持默认模型 + 单席位覆盖(报告席换更严谨的模型是常见用法)。

## 架构

```
┌─ console (React) ── 网关 (Python, 会话终结+TLS) ── agent-runtime (Node, :8090)
│                                                    ├─ 11 业务席位 + 3 配置席位 (pi-agent-core)
│                                                    ├─ MCP 情报源: fofa/quake/hunter/zoomeye/
│                                                    │  censys/shodan/github/cse/ipinfo/threatbook
│                                                    └─ Docker 沙箱: nuclei/hydra/nmap/fscan,
│                                                       安装账本化, 容器重建自动重放
├─ Temporal 工作流 (:7233) ── 战役调度 / 断点续跑 / 收尾对账
└─ OOB 收集器 (:19999) ── 带外判收, 落盘只读挂 /oob/, 沙箱直读实收
```

<details>
<summary><b>席位一览与配置隔离</b></summary>

| 席位 | 职责 | | 席位 | 职责 |
|---|---|---|---|---|
| autopwn | 编排/调度/对账 | | phish | 钓鱼模板与凭据回收 |
| recon | 测绘: 端口/路由/拓扑 | | c2 | 命令通道注册与生命周期 |
| nday | CVE 对账/变体绕过 | | persistence | 权限维持/拟态伪装 |
| weakcred | 爆破/凭据复用/喷洒 | | postex | 取证/横向面测绘 |
| api | 越权矩阵/批量赋值/JWT | | report | 独立复核: 立账/合并/驳回 |
| exploit | 漏洞挖掘/利用链 | | 配置三键 | skill/mcp/cli 配置独占 |

配置三键持有全部配置工具, 业务席位永不被配置提示词污染——这是硬边界, 不是约定。

</details>

### 技术选型(为什么不是自己造轮子)

- **pi-agent-core 做单席位骨架, 零修改。** 平台在其上做适配层, 逐项对齐官方契约(FileError 码表 / ShellOutputView / TruncationResult)——框架升级不破坏适配, 这是跑过五场战役验证过的边界。
- **Temporal 做编排, 不是自建任务队列。** 战役是持久化工作流: 席位中断可续跑、收尾自动对账、代拟报告标记 provisional 且被真终报自动作废——这些语义在裸进程模型里要重造一遍。
- **WAL 预写日志, 不信任内存。** 会话、事件、总线每变异先落盘再生效; 重启从 WAL 重放, 零丢失。消息级 fsync 语义, 崩溃窗口不吞产出。

## 可靠性工程

每一条对应一类真实事故, 修复后在后续战役中持续验证:

| 事故形态 | 机制 |
|---|---|
| 部署重启击杀流式回合(46 秒窗口铁证) | SIGTERM 优雅停机: 排空在飞回合再封存, 上限 110s; systemd `TimeoutStopSec=130s` |
| 进程崩溃/断电腰斩回合 | WAL 重放后检测腰斩形态(工具批完成但零产出), 自动注入续跑 |
| 模型接口 429/网络抖动 | 45-60s 退避自动重试, 记账类消息不再随限速蒸发 |
| 工作流长等待假死(三连 5 分钟误判) | 单次长挂改 60s 轮询探测, 根除传输层超时误报 |
| 重复落账/漏斗 | 同文幂等 + 修订链 append-only(现行版=链上最大修订号), 双账零容忍 |

## 测试

```bash
cd backend && npm test    # 65 用例
```

覆盖面: 互斥去重、会话生命周期、修订链折叠、幂等、授权作用域门、架构行数锁(核心文件行数漂移即红——防隐性重构)。

## 快速开始

```bash
git clone https://github.com/lalalala5678/spectre && cd spectre
sudo bash deploy/setup.sh    # 带域名: sudo bash deploy/setup.sh your.domain.com
```

一条命令: 依赖构建、admin 建号、systemd 服务、TLS。打开控制台, 设置页配任意 OpenAI 兼容模型, 输入目标——看它自己打。

> ⚠️ 一键脚本整机独占(8090/8081/443 + /etc/spectre); 共享机走下方手工路径。

<details>
<summary><b>手工部署</b>(共享机 / 排障 / 定制)</summary>

```bash
# ① 后端 (Node ≥ 22)
cd backend && cp .env.example .env   # INTERNAL_TOKEN 填随机串(删占位行, first-wins)
SPECTRE_DATA_DIR=/tmp/spectre-data npm i && npm test
SPECTRE_DATA_DIR=/tmp/spectre-data node agent-runtime.mjs

# ② 前端 (同 Node 版本)
cd ../console && npm i && npm run build

# ③ 网关 (纯 stdlib, 零第三方依赖)
cd ../gateway
SPECTRE_AUTH_DIR=/tmp/spectre-auth PASS='<密码>' python3 spectre-passwd.py add admin
INTERNAL_TOKEN=<同①> SPECTRE_DATA_DIR=/tmp/spectre-data \
  SPECTRE_AUTH_DIR=/tmp/spectre-auth python3 server.py
```

打开 `http://127.0.0.1:8081/spectre/`, admin 登录, 设置页配模型。远程纯 HTTP 测试需 `GATEWAY_INSECURE_COOKIE=1`, 生产走 TLS。

</details>

## FAQ

**AI 找的漏洞可信吗?**
独立报告席位逐条复核(复现证据+读全文+查库), 五场战役里驳回过自己人的误报; 每条落账漏洞带 POC 与证据链, 可逐条复验。

**会不会打没授权的目标?**
清单外目标首次触达即申请授权, 不批不打; 全程动作进审计链。平台不做代码级硬拦(硬拦拖慢节奏且形同虚设), 责任界面清晰: 授权在你, 执行在它, 记录在链。

**崩了/限速/重启怎么办?**
见[可靠性工程](#可靠性工程)——五种死法五种对策, 全部从事故修成机制。

**能接自己的模型吗?**
任意 OpenAI 兼容 / Anthropic / Gemini。四字段, 保存前真实探测; 支持单席位覆盖。

## 贡献与支持

- Bug / 功能建议: [提 Issue](https://github.com/lalalala5678/spectre/issues), 附复现步骤与日志片段
- PR: 触及核心文件(`tools/pi/sessions/routes`)请同步 `docs/ARCHITECTURE.md` 行数表(测试会锁), 跑通 `cd backend && npm test`
- 安全披露: 走私下渠道, 勿在公开 issue 贴未脱敏凭据

## 合规声明

SPECTRE 仅用于**已获书面授权**的渗透测试。平台内置授权清单与全程审计, 但合规责任在使用者——对未授权目标发起测试的一切后果与本项目无关。

## License

[MIT](./LICENSE) © 2026 lalalala5678
