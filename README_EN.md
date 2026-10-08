<div align="center">

# SPECTRE

**Multi-Agent Penetration Testing Platform**

Full-chain automation from asset mapping to report delivery — 11 stage agents, Temporal workflows, audit-replayable end to end.

[![GitHub Stars](https://img.shields.io/github/stars/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/stargazers)
[![GitHub Watchers](https://img.shields.io/github/watchers/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/watchers)
[![GitHub Forks](https://img.shields.io/github/forks/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/pulls)

[![GitHub License](https://img.shields.io/github/license/lalalala5678/spectre?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.4.0-blue.svg?style=flat-square)](./console/package.json)
[![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white)](./deploy/README.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./backend/package.json)

[English](./README_EN.md) | [中文文档](./README.md)

![console](console/screenshots/autopwn-full.png)

</div>

---

## What it is

Give SPECTRE a target and it handles the rest: map assets, reconcile the authorization boundary, dispatch specialized agents per stage, verify every finding, and produce evidence-chained reports. Your job is two things — approve authorization, read results.

During a real engagement the platform runs recon (port & fingerprint mapping), weakcred (credential spraying), api (BOLA/BFLA/IDOR matrices), exploit (chain construction), persistence (redundant footholds), and postex (forensics) concurrently, while the report agent independently re-verifies every finding before it lands in the ledger. All output flows through a single append-only event bus, rendered live in the console, surviving restarts.

**Design stance:**

- **Judgment belongs to agents, not the platform** — whether to merge or file a vulnerability, what severity to assign: the report agent reads the full text and decides. The platform provides mechanical channels only; zero "smart" interception.
- **Audit before everything** — every command, tool call, and event leaves a trace. Authorization is soft-prompted, never hard-blocked, but every action is attributable.
- **Survives process death** — write-ahead logging, automatic resumption of severed turns, graceful workflow shutdown. Deploy restarts don't kill in-flight work.

## Architecture

```
┌─ console (React) ── gateway (Python, :8081) ── agent-runtime (Node, :8090)
│                                                 ├─ 14 session agents (pi-agent-core)
│                                                 │    autopwn / recon / nday / weakcred / api
│                                                 │    exploit / phish / c2 / persistence
│                                                 │    postex / report / config trio
│                                                 ├─ MCP stdio servers (recon/nday intel)
│                                                 └─ sandbox (docker driver, CLI/skills mounts)
├─ worker (Temporal activities) ── temporal (:7233)
└─ oob-collector (:19999) ── OOB verdicts    /    Caddy TLS (:443)
```

| Agent | Role |
|---|---|
| autopwn | Orchestrator: decompose targets, dispatch seats, reconcile output, chain leads |
| recon | Asset mapping & fingerprinting: ports, routes, stacks, internal topology |
| nday | NDay validation: CVE reconciliation, template matching, variant bypasses |
| weakcred | Weak credentials: dictionary attacks, credential reuse, spraying |
| api | API pentest: authz matrices (BOLA/BFLA/IDOR), mass assignment, JWT |
| exploit | Vulnerability research & exploit-chain construction |
| phish | Phishing: mail templates, landing pages, credential recovery |
| c2 | Command channels: webshell/implant registration & lifecycle |
| persistence | Foothold redundancy & mimicry |
| postex | Post-exploitation: credential extraction, lateral mapping, forensics |
| report | Reports: independently re-verifies every lead; files, merges, or declines |

The config trio (skill-config / mcp-config / cli-config) holds all configuration tooling — business agents are never polluted by config prompts.

## Quick Start

```bash
git clone https://github.com/lalalala5678/spectre && cd spectre
sudo bash deploy/setup.sh    # with a domain: sudo bash deploy/setup.sh your.domain.com
```

One command: dependency build, admin bootstrap, systemd units, Caddy TLS. Entry point and credentials printed at the end.

> ⚠️ The one-shot script takes over the machine (occupies 8090/8081/443, writes `/etc/spectre`). On shared hosts use the [manual path](#manual-deployment).

<details>
<summary><b>Manual deployment</b> (shared hosts / debugging / customization)</summary>

```bash
# ① Backend (Node ≥ 22)
cd backend && cp .env.example .env
#    Edit .env: set INTERNAL_TOKEN to a random string (delete the placeholder
#    line — the parser is first-wins per line)
SPECTRE_DATA_DIR=/tmp/spectre-data npm i && npm test
SPECTRE_DATA_DIR=/tmp/spectre-data node agent-runtime.mjs

# ② Console (same Node version as ①)
cd ../console && npm i && npm run build

# ③ Gateway (pure stdlib, zero dependencies)
cd ../gateway
SPECTRE_AUTH_DIR=/tmp/spectre-auth PASS='<password>' python3 spectre-passwd.py add admin
INTERNAL_TOKEN=<same-as-①> SPECTRE_DATA_DIR=/tmp/spectre-data \
  SPECTRE_AUTH_DIR=/tmp/spectre-auth python3 server.py
```

Open `http://127.0.0.1:8081/spectre/` and log in as admin. Remote plain-HTTP testing needs `GATEWAY_INSECURE_COOKIE=1`; use TLS in production.

</details>

<details>
<summary><b>Configure the LLM</b> (after login, managed by the platform)</summary>

Settings → general config → API format (OpenAI-compatible / Anthropic / Gemini) + Base URL + API key + model name. The platform probes connectivity with the full config before saving. Per-agent overrides on top of the default provider (e.g. GLM default, DeepSeek for reports). Legacy `.env` `LLM_*` values are imported once on first boot; the env channel is dead afterwards.

</details>

## Tooling

| Layer | Contents |
|---|---|
| MCP | recon-datasources (fofa / quake / hunter / zoomeye / censys / shodan / github / cse / ipinfo / threatbook), nday-intel (nvd_cve), hot-mount custom servers |
| Shared tools | Every agent holds its own search_web / fetch_url instance (vertical channels need zero keys, optional provider fallback) |
| Sandbox CLI | nuclei / hydra / nmap / fscan etc.; installs are ledgered and replayed on container rebuild |
| Skills | agentskills.io format (SKILL.md), mounted per-agent, loaded on demand |
| OOB verdicts | :19999 TCP collector, read-only mount at `/oob/`; agents read actual receipts via `ls -t /oob/` |

## Authorization model

Autonomy first: targets inside the authorized scope never bother the agent again. Outside the scope, first contact triggers a one-time banner (per target); the agent decides whether to request authorization from the user. One approval propagates project-wide in real time (busy seats get it via immediate steering). No code-level hard blocks — authorization is a process, not a cage.

## Reliability

- **Write-ahead log** — sessions, events, and the bus hit disk on every mutation; crash-restart loses nothing.
- **Graceful shutdown** — SIGTERM drains in-flight turns (110s cap) before sealing; deploy restarts stop killing streaming work.
- **Severed-turn resumption** — after restart, turns killed mid-flight (tool batch done, zero output) are auto-detected and resumed; 429/network failures retry with 45-60s backoff.
- **No more false deaths** — workflow waits poll at 60s intervals (a single long-hang previously tripped transport-layer timeouts, causing three consecutive 5-minute false failures).

## Tests

```bash
cd backend && npm test    # 65 cases: dedup mutex / session lifecycle / revision chains / idempotency / scope gates / line-count locks
```

## Documentation

- [deploy/README.md](deploy/README.md) — full deployment: systemd units, sandbox, private-stack kill-verification, credential boundaries
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture decision records
- `docs/` — per-stage skill methodology and tooling
- [AGENTS.md](AGENTS.md) — the complete design spec for tooling & agent boundaries

## Compliance

SPECTRE is for penetration testing **with written authorization only**. The platform ships an authorization ledger and full audit chains, but compliance is the operator's responsibility. Consequences of testing unauthorized targets are not this project's.

## License

[MIT](./LICENSE) © 2026 lalalala5678
