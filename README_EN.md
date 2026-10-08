<div align="center">

# SPECTRE

### Give it a target. It hands you back a pentest report.

**Multi-agent penetration testing platform** — an 11-seat specialist red team, independent verification against hallucinated findings, fully auditable and replayable. You press "approve" twice.

[![GitHub Stars](https://img.shields.io/github/stars/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/stargazers)
[![GitHub Watchers](https://img.shields.io/github/watchers/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/watchers)
[![GitHub Forks](https://img.shields.io/github/forks/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/lalalala5678/spectre?style=flat-square)](https://github.com/lalalala5678/spectre/pulls)

[![GitHub License](https://img.shields.io/github/license/lalalala5678/spectre?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.4.0-blue.svg?style=flat-square)](https://github.com/lalalala5678/spectre/releases)
[![Tests](https://img.shields.io/badge/tests-65%20passing-brightgreen?style=flat-square)](#tests)
[![Docker](https://img.shields.io/badge/Docker-Sandbox-2496ED?style=flat-square&logo=docker&logoColor=white)](./deploy/README.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./backend/package.json)

[English](./README_EN.md) | [中文文档](./README.md)

![console](console/screenshots/autopwn-full.png)

</div>

---

## What a campaign looks like

You type: `pentest the Juice Shop at 127.0.0.1:30080`

From here you do nothing:

1. **Mapping** — recon sweeps 60+ endpoints, tech stack, hidden directories, internal topology; mid-run intel lands in the ledger in real time
2. **Asking permission** — target is out of scope, one confirmation card, you click approve (**the first of your two clicks**)
3. **Squad warfare** — while recon keeps mapping, weakcred sprays credentials, api lays authz matrices, exploit builds chains, nday reconciles CVEs — seats share intel automatically, zero duplicated labor
4. **Independent verification** — every lead goes to a **separate report seat** that reproduces the evidence, reads the full context, and checks the ledger: file it, merge it, or decline it with reasons. **The AI that finds a hole is not the AI that certifies it**
5. **Delivery** — a report with evidence chains, POCs, kill chains, and a negative-space list lands in the ledger. You open it (**second click**)

That Juice Shop campaign actually produced: **22 findings, 3 critical** (SQLi auth bypass / JWT forgery to admin / arbitrary file read), 24 of 116 official challenges triggered.

> Read a real report (sanitized): [docs/samples/sample-report.md](docs/samples/sample-report.md)

## Track record

Five public-range campaigns, **all fought by the agents themselves — humans only approved authorization**:

| Campaign | Stack | Findings | Highlights |
|---|---|---|---|
| crAPI v1.1.5 | Spring / Node / Mongo / PG | **30** (7 crit) | 5 complete kill chains; default DB creds → total compromise |
| WebGoat 8 | Java / Spring | **29** | Five JWT forgeries, XXE, SQLi; 12/12 lessons |
| vAPI | PHP / MySQL, OWASP API Top10 | **19** | 13/13 lessons; offline token forgery → full takeover |
| Juice Shop 20 | Node / Angular | **22** (3 crit) | 24/116 challenges; deserialization RCE chain closed |
| DVWA | PHP classic | **16** | 14/14 modules; dual-channel webshell persistence |

**116 findings total**, each with POC, evidence chain, and independent-verification record — traceable in the ledger.

## Why this isn't "a ChatGPT wrapper"

**Eleven specialists, each with their own arsenal.** Every seat holds its own toolchain and skills: the cracker runs dictionaries, the API seat lays matrices, the exploit seat builds chains — like a real red team. The orchestrator dispatches and reconciles; it doesn't do everything itself.

**The AI that finds a hole isn't the AI that certifies it.** An independent report seat re-verifies every lead (reproduce / read / check ledger) — across five campaigns it has declined its own teammates' false positives. Our direct answer to "AI pentesting = hallucination gift packs."

**Authorization is a process, not a cage.** In-scope targets never bother the agents; out-of-scope triggers a request on first contact, and one approval propagates to all seats instantly (streaming turns get it via immediate steering). No code-level hard blocks — but every command lands in an append-only audit chain. 100% attributable.

**The process dies; the campaign doesn't.** Not a slogan — these are mechanisms machined out of real incidents (see [Reliability engineering](#reliability-engineering)).

**Bring any model.** OpenAI-compatible / Anthropic / Gemini — four fields in settings, connectivity-probed before saving; per-seat overrides on top of the default.

## Architecture

```
┌─ console (React) ── gateway (Python, session termination + TLS) ── agent-runtime (Node)
│                                                                      ├─ 11 business seats + 3 config seats (pi-agent-core)
│                                                                      ├─ MCP intel: fofa/quake/hunter/zoomeye/
│                                                                      │  censys/shodan/github/cse/ipinfo/threatbook
│                                                                      └─ Docker sandbox: nuclei/hydra/nmap/fscan,
│                                                                         installs ledgered, replayed on rebuild
├─ Temporal workflows (:7233) ── campaign orchestration / resumption / closeout reconciliation
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

### Technology choices (why we didn't reinvent wheels)

- **pi-agent-core as the per-seat skeleton, zero modifications.** The platform is an adaptation layer above it, aligned item by item with the official contracts (FileError code table / ShellOutputView / TruncationResult) — framework upgrades don't break the adapter. A boundary proven across five campaigns.
- **Temporal for orchestration, not a homegrown task queue.** A campaign is a durable workflow: seats resume after interruption, closeout reconciles automatically, ghost reports are marked provisional and auto-voided by real ones — semantics you'd have to rebuild from scratch on bare processes.
- **Write-ahead log; memory is not trusted.** Sessions, events, and the bus hit disk on every mutation before taking effect; restarts replay from the WAL with zero loss.

## Reliability engineering

Every row corresponds to a real incident class, fixed and continuously validated in subsequent campaigns:

| Incident shape | Mechanism |
|---|---|
| Deploy restart killing a streaming turn (46-second window, forensically confirmed) | Graceful SIGTERM shutdown: drain in-flight turns before sealing, 110s cap; systemd `TimeoutStopSec=130s` |
| Crash / power loss severing a turn mid-flight | Post-replay severed-turn detection (tool batch done, zero output) with automatic resumption |
| Provider 429 / network jitter | 45-60s backoff auto-retry; accounting messages no longer evaporate with rate limits |
| Workflow long-wait false deaths (three consecutive 5-minute misjudgments) | Single long-hang replaced with 60s polling probes; transport-timeout false positives eliminated |
| Duplicate / dropped findings | Same-text idempotency + append-only revision chains (current = highest revision); zero tolerance for double-entry |

## Tests

```bash
cd backend && npm test    # 65 cases
```

Coverage: dedup mutex, session lifecycle, revision-chain folding, idempotency, authorization scope gates, and architecture line-count locks (drift in core files turns red — guarding against silent refactors).

## Quick start

```bash
git clone https://github.com/lalalala5678/spectre && cd spectre
sudo bash deploy/setup.sh    # with a domain: sudo bash deploy/setup.sh your.domain.com
```

One command: build, admin bootstrap, systemd services, TLS. Open the console, point it at any OpenAI-compatible model, type a target — and watch.

> ⚠️ The one-shot script takes over the machine (8090/8081/443 + /etc/spectre). Shared hosts: manual path below.

<details>
<summary><b>Manual deployment</b></summary>

```bash
# ① Backend (Node ≥ 22)
cd backend && cp .env.example .env   # set INTERNAL_TOKEN (delete placeholder line, first-wins)
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

Open `http://127.0.0.1:8081/spectre/`, log in, configure the model in settings. Remote plain-HTTP testing needs `GATEWAY_INSECURE_COOKIE=1`; use TLS in production.

</details>

## FAQ

**Can I trust AI-found vulnerabilities?**
An independent report seat re-verifies every lead (reproduce / read / check ledger); it has declined its own teammates' false positives across five campaigns. Every filed finding ships a POC and evidence chain you can re-check.

**Will it attack unauthorized targets?**
Out-of-scope targets request authorization on first contact; no approval, no attack. Everything lands in the audit chain. No code-level hard blocks (hard blocks wreck tempo and are trivially bypassed anyway) — the responsibility boundary is clean: authorization is yours, execution is theirs, the record is on the chain.

**Crashes / rate limits / restarts?**
See [Reliability engineering](#reliability-engineering) — five failure modes, five purpose-built mechanisms, each machined from a real incident.

**Can I use my own model?**
Any OpenAI-compatible / Anthropic / Gemini endpoint. Four fields, probed before saving; per-seat overrides supported.

## Contributing & Support

- Bugs / features: [open an issue](https://github.com/lalalala5678/spectre/issues) with reproduction steps and log excerpts
- PRs: touching core files (`tools/pi/sessions/routes`)? Sync the line-count table in `docs/ARCHITECTURE.md` (tests lock it) and pass `cd backend && npm test`
- Security disclosures: private channels only — never post unredacted credentials in public issues

## Compliance

SPECTRE is for penetration testing **with written authorization only**. The platform ships an authorization ledger and full audit chains, but compliance is the operator's responsibility.

## License

[MIT](./LICENSE) © 2026 lalalala5678
