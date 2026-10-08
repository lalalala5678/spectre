<div align="center">

# SPECTRE

### Give it a target. It hands you back a pentest report.

**Multi-agent penetration testing platform** — 11 specialist agents in coordinated battle. You press "approve" twice.

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

## What a campaign looks like

You type: `pentest the Juice Shop at 127.0.0.1:30080`

From here you do nothing:

1. **Mapping** — the recon agent sweeps 60+ endpoints, tech stack, hidden directories, internal topology
2. **Asking permission** — target isn't in the authorized scope, one confirmation card pops up, you click approve (**the first of your two clicks**)
3. **Squad warfare** — while recon keeps mapping, weakcred sprays credentials, api lays out authz matrices, exploit builds chains, nday reconciles CVEs — all in parallel
4. **Independent verification** — every finding is **re-verified by a separate report agent** before it can enter the ledger. The AI that finds the hole is not the AI that certifies it
5. **Delivery** — a full report with evidence chains, POCs, kill chains, and a negative-space list lands in the ledger. You open it and read (**second click**)

Actual Juice Shop campaign output: **22 findings, 3 critical** (SQLi auth bypass / JWT forgery to admin / arbitrary file read), 24 of the official 116 challenges triggered. Zero human intervention beyond authorization.

> Read a real report (sanitized): [docs/samples/sample-report.md](docs/samples/sample-report.md)

## Track record

During development the platform ran five public-range campaigns end to end — **every one fought by the agents themselves; humans only approved authorization**:

| Campaign | Target type | Findings | Highlights |
|---|---|---|---|
| crAPI v1.1.5 | Modern API stack (Spring/Node/Mongo) | **30** (7 critical) | 5 complete kill chains; default DB credentials → full compromise |
| WebGoat 8 | Java/Spring enterprise | **29** | Five JWT forgeries, XXE, SQLi; 12/12 lessons |
| vAPI | PHP/MySQL, OWASP API Top 10 | **19** | 13/13 lessons; offline API-token forgery → full takeover |
| Juice Shop 20 | Node/Angular e-commerce | **22** (3 critical) | 24/116 official challenges; deserialization RCE chain closed |
| DVWA | PHP classic | **16** | 14/14 modules; dual-channel webshell persistence |

**116 findings total.** Every one carries a POC, evidence chain, and independent-verification record — traceable in the intel ledger.

## Six things that make it more than "one ChatGPT pretending"

**1. Eleven specialists, not one model wearing eleven hats**

Recon, weakcred, api, exploit, persistence, postex — each seat has its own toolchain, skill set, and prompt. The cracker runs dictionaries, the API seat lays authz matrices, the exploit seat builds chains. Like a real red team. The orchestrator dispatches and reconciles; it doesn't do everything itself.

**2. The AI that finds a hole isn't the AI that certifies it**

Every lead goes to an independent report agent: re-reads context, reproduces evidence, checks the existing ledger — files it, merges it, or declines it with reasons. That's our answer to "AI pentesting = hallucination gift packs."

**3. Authorization is a process, not a cage**

Targets inside the scope never bother the agents again. Outside, first contact requests permission; one approval propagates project-wide instantly. No code-level hard blocks — but every command and event lands in an append-only audit chain.

**4. The process dies; the campaign doesn't**

Write-ahead log on every mutation. Deploys drain in-flight turns before restart. Severed turns resume from the breakpoint after a crash. Rate limits back off and retry. Each of these exists because a real incident demanded it.

**5. Full audit replay**

Every command, tool call, DM, and reasoning turn lands in the event bus and replays in the console timeline. Vulnerability reports carry revision chains (who changed what, when, why). The ledger is append-only.

**6. Bring any model**

OpenAI-compatible / Anthropic / Gemini — four fields in settings, probed with a real request before saving. Default model plus per-seat overrides.

## Architecture at a glance

```
┌─ console (React) ── gateway (Python) ── agent-runtime (Node)
│                                      ├─ 11 business agents + 3 config agents (pi-agent-core)
│                                      ├─ MCP intel: fofa/quake/hunter/zoomeye/censys/shodan...
│                                      └─ Docker sandbox: nuclei/hydra/nmap, container-isolated
├─ Temporal workflows ── campaign orchestration / resumption / ghost-report handling
└─ OOB collector (:19999) ── out-of-band verdicts, readable from the sandbox
```

<details>
<summary><b>Agent seats</b></summary>

| Seat | Role |
|---|---|
| autopwn | Orchestrator: decompose, dispatch, reconcile |
| recon | Asset mapping: ports, routes, stacks, topology |
| nday | NDay validation: CVE reconciliation, variants |
| weakcred | Credential attacks: dictionaries, reuse, spraying |
| api | API pentest: authz matrices, mass assignment, JWT |
| exploit | Vulnerability research & chain construction |
| phish | Phishing: templates, landing pages, recovery |
| c2 | Command channels: registration & lifecycle |
| persistence | Footholds: redundancy, mimicry |
| postex | Post-exploitation: forensics, lateral mapping |
| report | Reports: independently verifies every lead |

The config trio holds all configuration tooling — business seats are never polluted.

</details>

## Quick start

```bash
git clone https://github.com/lalalala5678/spectre && cd spectre
sudo bash deploy/setup.sh    # with a domain: sudo bash deploy/setup.sh your.domain.com
```

One command: build, admin bootstrap, systemd services, TLS. Open the console, point it at any OpenAI-compatible model, type a target — and watch.

> ⚠️ The one-shot script takes over the machine (8090/8081/443 + /etc/spectre). On shared hosts use the [manual path](#manual-deployment).

<details>
<summary><b>Manual deployment</b></summary>

```bash
# ① Backend (Node ≥ 22)
cd backend && cp .env.example .env   # set INTERNAL_TOKEN (delete placeholder line)
SPECTRE_DATA_DIR=/tmp/spectre-data npm i && npm test
SPECTRE_DATA_DIR=/tmp/spectre-data node agent-runtime.mjs

# ② Console
cd ../console && npm i && npm run build

# ③ Gateway (pure stdlib)
cd ../gateway
SPECTRE_AUTH_DIR=/tmp/spectre-auth PASS='<pw>' python3 spectre-passwd.py add admin
INTERNAL_TOKEN=<same> SPECTRE_DATA_DIR=/tmp/spectre-data \
  SPECTRE_AUTH_DIR=/tmp/spectre-auth python3 server.py
```

Open `http://127.0.0.1:8081/spectre/`, log in as admin, configure the model in settings.

</details>

## FAQ

**Can I trust AI-found vulnerabilities?**
Every lead is independently re-verified by the report seat before landing; across our five campaigns it has also declined its teammates' false positives. Every finding ships a POC and evidence chain you can re-check.

**Will it attack unauthorized targets?**
Out-of-scope targets trigger an authorization request on first contact. No approval, no attack. The platform doesn't hard-block (that would wreck tempo), but the audit chain keeps every action attributable.

**What about crashes / restarts / rate limits?**
See "six things" #4 — each failure mode has a purpose-built recovery mechanism, earned from real incidents.

**Can I use my own model?**
Yes — any OpenAI-compatible / Anthropic / Gemini endpoint. Four fields in settings, connectivity-probed before saving.

## Contributing & Support

- Bugs / features: [open an issue](https://github.com/lalalala5678/spectre/issues) with reproduction steps and log excerpts
- PRs: sync `docs/ARCHITECTURE.md` line-count table for core-file changes (tests lock it); pass `cd backend && npm test`
- Security disclosures: private channels only — never post unredacted credentials in public issues

## Compliance

SPECTRE is for penetration testing **with written authorization only**. The platform ships an authorization ledger and full audit chains, but compliance is the operator's responsibility.

## License

[MIT](./LICENSE) © 2026 lalalala5678
