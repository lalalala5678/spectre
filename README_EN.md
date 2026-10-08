<div align="center">

# SPECTRE

### Give it a target. It hands you back a pentest report.

**Multi-agent penetration testing platform** — an 11-seat specialist red team, independently verified findings, fully auditable and replayable

[![GitHub Stars](https://img.shields.io/github/stars/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/stargazers)
[![GitHub Watchers](https://img.shields.io/github/watchers/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/watchers)
[![GitHub Forks](https://img.shields.io/github/forks/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/pulls)

[![GitHub License](https://img.shields.io/github/license/lalalala5678/spectre?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.4.0-blue.svg?style=flat-square)](https://github.com/lalalala5678/spectre/releases)
[![Tests](https://img.shields.io/badge/tests-65%20passing-brightgreen?style=flat-square)](#tests)
[![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white)](./deploy/README.md)

[English](./README_EN.md) | [中文文档](./README.md)

![console](console/screenshots/autopwn-full.png)
*Orchestrator (AutoPwn) battle view — campaign timeline on the left, tool-call detail on the right. Every seat gets the same interface.*

</div>

---

## Why SPECTRE

**You press "approve" twice.** Type a target; from there recon maps, weakcred cracks, api lays authz matrices, exploit builds chains, nday reconciles CVEs — all in parallel. Every lead is **re-verified by an independent report seat** before entering the ledger. A report with evidence chains, POCs, kill chains, and a negative-space list lands at the end. Two clicks: one approval, one to open the report.

**The AI that finds a hole isn't the AI that certifies it.** Discovery and judgment seats are separate — the verifier reproduces the evidence, reads the full context, checks the ledger: file it, merge it, or decline it with reasons. Across five real campaigns it has declined its own teammates' false positives. Our direct answer to "AI pentesting = hallucination gift packs."

**116 real findings, every one traceable.** During development the platform ran five fully autonomous campaigns against public ranges (see the track record below). Every output is in the ledger — POC, evidence chain, verification record, revision history.

**The process dies; the campaign doesn't.** Write-ahead log on every mutation; deploys drain in-flight turns before restart; severed turns resume from the breakpoint; rate limits back off and retry. Not aspirations — each mechanism was machined from a real incident (see [Reliability engineering](#reliability-engineering)).

**Bring any model.** OpenAI-compatible / Anthropic / Gemini — four fields in the console, connectivity-probed before saving; per-seat overrides on top of the default.

## Track record

| Campaign | Stack | Findings | Highlights |
|---|---|---|---|
| crAPI v1.1.5 | Spring / Node / Mongo / PG | **30** (7 critical) | 5 complete kill chains; default DB creds → total compromise |
| WebGoat 8 | Java / Spring | **29** | Five JWT forgeries, XXE, SQLi; 12/12 lessons |
| vAPI | PHP / MySQL, OWASP API Top10 | **19** | 13/13 lessons; offline token forgery → full takeover |
| Juice Shop 20 | Node / Angular | **22** (3 critical) | 24/116 challenges; deserialization RCE chain closed |
| DVWA | PHP classic | **16** | 14/14 modules; dual-channel webshell persistence |

**116 total, humans only approved authorization.** A sanitized sample report: [docs/samples/sample-report.md](docs/samples/sample-report.md)

## Interface tour

### 🪖 Agent battle view

Every seat (orchestrator / recon / weakcred / api / exploit / …) gets its own session view: battle timeline on the left (messages, tool calls, reasoning), detail panel on the right.

![autopwn](console/screenshots/autopwn-full.png)

### 📋 Vulnerability & report panel

All output flows into an append-only intel ledger: vulnerability entries with severity / discoverer / revision chains, task reports with status. Full-text search and pagination.

![reports](console/screenshots/panel-reports.png)

### 🔗 Audit & evidence chain

Every command, tool call, and event is traceable — the evidentiary backbone of a pentest report.

![audit](console/screenshots/panel-audit.png)

### 🐚 Shell console

Command channels (webshells / implants) registered during engagements are managed centrally: status, validity, execution audit. OOB verdicts land on a read-only mount readable straight from the sandbox.

![shells](console/screenshots/panel-shells.png)

### ⚙️ Runtime configuration

Model config (four fields, probed before saving), data-source credentials, authorization scope — all in the console. No code edits, no env vars.

![settings](console/screenshots/panel-settings.png)

## Architecture

```
┌─ console (React) ── gateway (Python, sessions + TLS) ── agent-runtime (Node, :8090)
│                                                               ├─ 11 business seats + 3 config seats (pi-agent-core)
│                                                               ├─ MCP intel: fofa/quake/hunter/zoomeye/
│                                                               │  censys/shodan/github/cse/ipinfo/threatbook
│                                                               └─ Docker sandbox: nuclei/hydra/nmap/fscan,
│                                                                  installs ledgered, replayed on rebuild
├─ Temporal workflows (:7233) ── campaign orchestration / resumption / closeout
└─ OOB collector (:19999) ── out-of-band verdicts, read-only mount at /oob/
```

<details>
<summary><b>Seats & configuration isolation</b></summary>

| Seat | Role | | Seat | Role |
|---|---|---|---|---|
| autopwn | Orchestrate / dispatch / reconcile | | phish | Phishing templates & recovery |
| recon | Mapping: ports / routes / topology | | c2 | Channel registration & lifecycle |
| nday | CVE reconciliation / variants | | persistence | Footholds / mimicry |
| weakcred | Cracking / reuse / spraying | | postex | Forensics / lateral mapping |
| api | Authz matrices / mass assign / JWT | | report | Independent verification |
| exploit | Research & chain construction | | config trio | skill/mcp/cli exclusive |

The config trio holds all configuration tooling — business seats are never polluted by config prompts. A hard boundary, not a convention.

</details>

### Technology choices

- **pi-agent-core as the per-seat skeleton, zero modifications.** The platform is an adaptation layer aligned item by item with the official contracts (FileError code table / ShellOutputView / TruncationResult) — framework upgrades don't break the adapter; a boundary proven across five campaigns.
- **Temporal for orchestration, not a homegrown task queue.** A campaign is a durable workflow: seats resume after interruption, closeout reconciles automatically, ghost reports are marked provisional and auto-voided by real ones — semantics you'd rebuild from scratch on bare processes.
- **Write-ahead log; memory is not trusted.** Sessions, events, and the bus hit disk on every mutation before taking effect; restarts replay from the WAL with zero loss.

## Reliability engineering

Every row corresponds to a real incident class, fixed and validated in subsequent campaigns:

| Incident shape | Mechanism |
|---|---|
| Deploy restart killing a streaming turn (46-second window, forensically confirmed) | Graceful SIGTERM shutdown: drain in-flight turns before sealing, 110s cap |
| Crash / power loss severing a turn | Post-replay severed-turn detection (tool batch done, zero output) with automatic resumption |
| Provider 429 / network jitter | 45-60s backoff auto-retry; accounting messages no longer evaporate |
| Workflow long-wait false deaths (three consecutive 5-minute misjudgments) | Single long-hang replaced with 60s polling probes |
| Duplicate / dropped findings | Same-text idempotency + append-only revision chains; zero tolerance for double-entry |

## Quick start

```bash
git clone https://github.com/lalalala5678/spectre && cd spectre
sudo bash deploy/setup.sh    # with a domain: sudo bash deploy/setup.sh your.domain.com
```

One command: build, admin bootstrap, systemd services, TLS. Open the console, configure any OpenAI-compatible model, type a target — and watch.

> ⚠️ The one-shot script takes over the machine (8090/8081/443 + /etc/spectre). Shared hosts: manual path below.

<details>
<summary><b>Manual deployment</b></summary>

```bash
# ① Backend (Node ≥ 22)
cd backend && cp .env.example .env   # set INTERNAL_TOKEN (delete placeholder, first-wins)
SPECTRE_DATA_DIR=/tmp/spectre-data npm i && npm test
SPECTRE_DATA_DIR=/tmp/spectre-data node agent-runtime.mjs

# ② Console (same Node version)
cd ../console && npm i && npm run build

# ③ Gateway (pure stdlib, zero dependencies)
cd ../gateway
SPECTRE_AUTH_DIR=/tmp/spectre-auth PASS='<pw>' python3 spectre-passwd.py add admin
INTERNAL_TOKEN=<same> SPECTRE_DATA_DIR=/tmp/spectre-data \
  SPECTRE_AUTH_DIR=/tmp/spectre-auth python3 server.py
```

Open `http://127.0.0.1:8081/spectre/`, log in, configure the model in settings.

</details>

## Tests

```bash
cd backend && npm test    # 65 cases: dedup mutex / session lifecycle / revision chains / idempotency / scope gates / line-count locks
```

## FAQ

**Can I trust AI-found vulnerabilities?** An independent report seat re-verifies every lead; it has declined its own teammates' false positives. Every filed finding ships a POC and evidence chain you can re-check.

**Will it attack unauthorized targets?** Out-of-scope targets request authorization on first contact; no approval, no attack. Authorization is yours, execution is theirs, the record is on the chain.

**Crashes / rate limits / restarts?** See [Reliability engineering](#reliability-engineering) — five failure modes, five mechanisms machined from real incidents.

**Can I use my own model?** Any OpenAI-compatible / Anthropic / Gemini endpoint. Four fields, probed before saving, per-seat overrides supported.

## Contributing & Support

- Bugs / features: [open an issue](https://github.com/lalalala5678/spectre/issues) with reproduction steps and log excerpts
- PRs: sync `docs/ARCHITECTURE.md` line-count table for core-file changes (tests lock it) and pass `cd backend && npm test`
- Security disclosures: private channels only — never post unredacted credentials in public issues

## Compliance

SPECTRE is for penetration testing **with written authorization only**. The platform ships an authorization ledger and full audit chains, but compliance is the operator's responsibility.

## License

[MIT](./LICENSE) © 2026 lalalala5678
