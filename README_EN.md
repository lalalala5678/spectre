<div align="center">

<img src="console/public/favicon.svg" width="96" alt="SPECTRE"/>

# SPECTRE

**Multi-agent penetration testing platform**

### Built for China's real attack surface · multi-step intrusion paths that mirror real playbooks · a full graphical Web UI

[![GitHub Stars](https://img.shields.io/github/stars/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/stargazers)

[![GitHub License](https://img.shields.io/github/license/lalalala5678/spectre?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.4.0-blue.svg?style=flat-square)](https://github.com/lalalala5678/spectre/releases)
[![Tests](https://img.shields.io/badge/tests-67%20passing-brightgreen?style=flat-square)](#tests)
[![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white)](./deploy/README.md)

[English](./README_EN.md) | [中文文档](./README.md)

![console](console/screenshots/autopwn-full.png)
*Orchestrator (AutoPwn) battle view — campaign timeline on the left, tool-call detail on the right. Every seat gets the same interface.*

</div>

---

## Why SPECTRE

Type a target and the orchestrator runs the engagement itself: it calls the recon agent to map the target via fofa/quake intel sources and port scans, then decides from fingerprints and exposed surface which seats to invoke next — weak-credential cracking, authz matrices, exploit-chain construction, CVE reconciliation — mirroring how a human pentest team actually works, and closes with a final report carrying evidence chains, POCs, and a list of verified-no-finding items.

**Seats are freely outfittable.** Through the three config agents you can mount MCP intel sources, custom skills, and shared CLI tools (installed once, available to every seat) on any seat — all from the Web console, no code changes.

**Discovery and verdict are separated.** The seat that finds a vulnerability is not the seat that certifies it: the verifier reproduces the evidence, reads the full context, checks the ledger — then files it into the vulnerability store (referred to below as "ledger entry"), merges duplicates, or declines with reasons. During development campaigns it declined its own teammates' false positives.

**Two bodies of field work.** Five end-to-end campaigns against public ranges during development (116 findings); then 52 campaigns against 52 universities in a single 24-hour run, producing 119 findings (8 critical / 28 high / 47 medium / 36 low) — one university closed out every 28 minutes on average.

**Interruption-recovery boundaries.** Sessions, events, and the bus are write-ahead-logged on every mutation; deploys drain in-flight turns before restart; severed turns resume from the breakpoint; provider rate limits back off and retry. See [Reliability engineering](#reliability-engineering) for where each mechanism came from.

**Model access.** OpenAI-compatible / Anthropic / Gemini — four fields in the console, connectivity-probed before saving; per-seat overrides on top of the default.

## Track record

### EduSRC Higher-Education Campaigns

**24 hours × 52 universities × 119 findings** — asset mapping → fingerprinting → verification → impact reinforcement → independent review before ledger entry, one university closed out every 28 minutes on average. A sanitized single-university sample report: [docs/samples/edusrc-sample-report.md](docs/samples/edusrc-sample-report.md)

| Dimension | Data |
|---|---|
| Campaigns | **52 universities in 24 hours** (avg 2.3 each; worst-case result: a single request read the sensitive records of **8,394 faculty members** at one Double First-Class university) |
| Findings | **119 total**: **critical×8** / high×28 / medium×47 / low×36 |
| Depth | One Double First-Class university fully breached: captcha-free brute-force on the SSO enumerated 14k student IDs → weak student credential → same credential logs into the SSL VPN → L3 tunnel via re-implemented open-source client bypassing gateway ACLs → 137k-attempt faculty-ID dictionary hits a teacher account → teacher JWT calls a research-management API beyond its role → one request dumps the full 8,394-person database, yielding a complete dataset of ID numbers and salted password hashes |

**Representative findings** (by attack surface):

- **SSO / identity family**: one Double First-Class university — captcha-free enumeration oracle → admin weak credential → campus-wide SSO takeover (critical); one 985 university — remember-me cookie storing password-equivalent plaintext; one Double First-Class university — faculty ID format extracted from a leaked user tree
- **OA family**: one 985 university — Weaver e-cology VerifyQuickLogin unauthenticated admin takeover (critical); another 985 university — self-built PHP mail login page found **actively backdoored by a third party** (critical — full payload chain reverse-engineered: hidden iframe → DES exfil engine → cross-site identity theft)
- **Dev leftovers**: one Sino-foreign joint-venture university — career-services platform exposing dev-login in production: POST a known netId, no password, receive system_admin JWT (critical); same platform's IDM export leaks full faculty PII (critical)
- **Research computing**: one Double First-Class university — HPC portal arbitrary-path file write (high, write→execute chain honestly downgraded after proving unreachable) / IDOR reading campus-wide job ledger / unfiltered full account tree; lab-safety system student-JWT vertical escalation
- **RCE**: one 211 university — visualization platform unauthenticated command injection (critical, benign-command echo then stop)
- **Gateways & keys**: one 211 university — WebVPN shipping its factory-default URL-rewrite key (key embedded in plaintext in every unauth response, cross-campus default corroborated) → unauthenticated proxy to whitelisted host; one 985 university — SSL VPN with deprecated TLS + 1024-bit keys
- **Vertical app family**: one 211 university — ACM/OJ submitter real-IP leak + group-problem cross-tenant download; library SaaS admin endpoint unauthenticated; one 985 university — admissions/careers/finance systems with hardcoded AES keys, server-side captcha no-ops, XFF-spoofable lockouts

### Range testing

**5 public ranges, 3 cleared every lesson first pass without friction** (WebGoat / vAPI / DVWA); crAPI and Juice Shop yielded all core exploit chains. 116 findings total; a sanitized sample report: [docs/samples/sample-report.md](docs/samples/sample-report.md)

| Campaign | Stack | Findings | Highlights |
|---|---|---|---|
| crAPI v1.1.5 | Spring / Node / Mongo / PG | **30** (7 critical) | SQL injection reading the full database; default DB credentials connect to every data store; 5 end-to-end chains (entry → credentials → data) |
| WebGoat 8 | Java / Spring | **29** | JWT algorithm-confusion forging admin sessions; XXE reading server files; SQL injection extracting full tables |
| vAPI | PHP / MySQL, OWASP API Top10 | **19** | Login SQL injection bypassing authentication; offline token forgery grants every admin API |
| Juice Shop 20 | Node / Angular | **22** (3 critical) | Deserialization from entry to command execution (RCE) |
| DVWA | PHP classic | **16** | Command injection and file upload each yield a webshell (command execution); persistence covers register–execute–audit |

## Interface tour

### 🪖 Agent battle view

Every seat (orchestrator / recon / weakcred / api / exploit / …) gets its own session view: battle timeline on the left (messages, tool calls, reasoning), detail panel on the right.

![autopwn](console/screenshots/autopwn-full.png)

### 📋 Vulnerability & report panel

All output flows into an append-only intel ledger: vulnerability entries with severity / discoverer / revision chains, task reports with status. Full-text search and pagination.

![reports](console/screenshots/panel-reports.png)

### 🔗 Audit & evidence chain

Every command, tool call, and event is traceable — the evidentiary backbone of every finding.

![audit](console/screenshots/panel-audit.png)

### 🐚 Shell console

Command channels (webshells / implants) registered during engagements are managed centrally: status, validity, execution audit. Out-of-band callback verification (OOB): callbacks land on a read-only mount, readable straight from the sandbox.

![shells](console/screenshots/panel-shells.png)

### ⚙️ Runtime configuration

Model config (four fields, probed before saving), data-source credentials — all in the console. No code edits, no env vars.

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
└─ OOB collector (:19999) ── out-of-band callback verification, read-only mount at /oob/
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
| exploit | Research & chain construction | | config agents ×3 | skill/mcp/cli exclusive |

The three config agents hold all configuration tooling; business seats never see config prompts (an architectural boundary — see the seat table).

</details>

### Technology choices

- **pi-agent-core as the per-seat skeleton, zero modifications.** The platform is an adaptation layer aligned item by item with the official contracts (FileError code table / ShellOutputView / TruncationResult) — framework upgrades don't break the adapter.
- **Temporal for orchestration, not a homegrown task queue.** A campaign is a durable workflow: seats resume after interruption, closeout reconciles automatically, system-drafted ghost reports are auto-voided by real ones — semantics you'd rebuild from scratch on bare processes.
- **Write-ahead log; memory is not trusted.** Sessions, events, and the bus hit disk on every mutation before taking effect; restarts replay from the WAL with zero loss.

## Reliability engineering

Every row corresponds to a real incident class, fixed and validated in subsequent campaigns:

| Incident shape | Mechanism |
|---|---|
| Deploy restart killing a streaming turn (46-second window, forensically confirmed) | Graceful SIGTERM shutdown: drain in-flight turns before sealing, 110s cap |
| Crash / power loss severing a turn | Post-replay severed-turn detection (tool batch done, zero output) with automatic resumption |
| Provider 429 / network jitter | 45-60s backoff auto-retry; accounting messages no longer evaporate |
| Workflow long-wait false deaths (three consecutive 5-minute misjudgments) | Single long-hang replaced with 60s polling probes |
| Duplicate / dropped findings | Same-text idempotency + append-only revision chains; duplicates auto-merge |

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
cd backend && cp .env.example .env   # set INTERNAL_TOKEN to a random string
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
cd backend && npm test    # 67 cases: dedup mutex / session lifecycle / revision chains / idempotency / line-count locks
```

## FAQ

**Can I trust AI-found vulnerabilities?** Every lead is re-verified by an independent seat before filing (see "Discovery and verdict are separated" above); filed findings ship a POC and evidence chain you can re-check.

**Crashes / rate limits / restarts?** See [Reliability engineering](#reliability-engineering) — five incident classes with their mechanisms.

**Can I use my own model?** See "Model access" above.

## Contributing & Support

- Bugs / features: [open an issue](https://github.com/lalalala5678/spectre/issues) with reproduction steps and log excerpts
- PRs: sync `docs/ARCHITECTURE.md` line-count table for core-file changes (tests lock it) and pass `cd backend && npm test`
- Security disclosures: private channels only — never post unredacted credentials in public issues

## License

[MIT](./LICENSE) © 2026 lalalala5678

---

Compliance is the operator's responsibility.
