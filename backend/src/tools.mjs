/**
 * Session-scoped agent tools.
 *
 * Tools are built per-session (they close over the session record) and
 * receive a `caps` capability bag injected by the composition root, so this
 * module never imports Temporal or the bus directly — the architecture rule
 * "worker/runtime only meet through injected capabilities" holds.
 *
 * Tool matrix (LLM-facing; usability rule: one obvious tool per intent,
 * never a hard reject when a sensible default exists; CS2-#4 按 14924dc
 * 漏洞撰写收权后的现行实况重写——publish_vulnerability 仅 report 会话持有):
 *   基础面(全会话): bash/read/write/edit 官方四件 + query_intel/
 *                   read_session/revise_entry + search_web/fetch_url(各持
 *                   独立实例)——逐项以 buildToolingTools/装配代码为准。
 *   差异面: 编排器另持 dispatch_agents/relay_to_agents(+buildChildTools
 *           尾巴, matrix.test 机锁); 子会话另持 spawn_agent;
 *           report 会话独占 publish_vulnerability(CS23-N12: 此前逐行
 *           罗列每轮新增工具都漏同步——改摘要式, 清单见装配处)。
 */

import { Type } from '@earendil-works/pi-ai';

import { CONFIG } from './config.mjs';
import { clipMarked } from './pi.mjs';
import { foldRevisions } from './revision.mjs';
import { buildToolingTools } from './sandbox/tooling.mjs';

/** Stage agents(10)——CS2-#21 单源导出(routes 此前内联同款字面量)。 */
export const STAGE_KEYS = [
  'recon', 'nday', 'weakcred', 'api', 'exploit',
  'phish', 'c2', 'persistence', 'postex', 'report',
];

const stageEnum = Type.Enum(
  Object.fromEntries(STAGE_KEYS.map((key) => [key, key])),
);

/** Spawnable stage keys — 'report' EXCLUDED: the report writer is a
 *  platform service woken via the report_vulnerability tool (and by the
 *  user from the console nav). CS20-12: dispatch_agents 的枚举(temporal
 *  侧只滤 autopwn)现状仍含 report(decision pending, 见
 *  matrix.test.mjs 钉死用例)——本表仅约束 spawn_agent 直派面。 */
export const SPAWNABLE_KEYS = STAGE_KEYS.filter(k => k !== 'report');
const spawnStageEnum = Type.Enum(
  Object.fromEntries(SPAWNABLE_KEYS.map((key) => [key, key])),
);

/**
 * Shared intel tools — the project intel base every agent reads and
 * writes. Task reports are the PROCESS record (mandatory at every quiet
 * point, even with zero vulns); intel notes and vulnerabilities are the
 * RESULT records, published via publish_intel / publish_vulnerability.
 * All live on the bus with frozen
 * provenance, readable by any agent in the same work session.
 *
 * @param {object} record  session record (run counters live here)
 * @param {object} caps    { emitBus, authorOf, listBus }
 */
export function buildIntelTools(record, caps) {
  const queryIntel = {
    name: 'query_intel',
    label: '查询情报',
    description:
      '[read-only] Read vulnerabilities, intel notes and task reports published ' +
      'by ANY agent in this ' +
      'project — the orchestrator, siblings, or yourself. Helpful whenever ' +
      'you need context you do not have: targets, platforms, credentials, ' +
      'scope (e.g. before writing platform-specific malware, check the ' +
      'recon agent\'s reports), or the full details of a finished child\'s ' +
      'output. Pass `seq` (from a previous result) to fetch ONE entry in ' +
      'full detail.',
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([
        Type.Literal('task-report'), Type.Literal('vulnerability'),
        Type.Literal('intel'), Type.Literal('both'), Type.Literal('reports'),
        Type.Literal('vuln'), Type.Literal('vulnerabilities'), Type.Literal('notes'),
        Type.Literal('task_report'),
      ], { description: 'Entry kind: task-report(=reports) / vulnerability(=vuln) / intel(=notes) / both. Default both' })),
      seq: Type.Optional(Type.Number({
        description: 'Fetch ONE entry in full detail by its seq (from a previous listing)',
      })),
      author: Type.Optional(Type.String({
        description: '按智能体代号或 agentKey 过滤,如 "边界测绘一号" / "recon" (两者皆可)',
      })),
      agentType: Type.Optional(Type.Union([
        stageEnum, Type.Literal('autopwn'),
      ], { description: 'Filter by stage agentKey (recon/api/c2/…), 不含派生代号' })),
      status: Type.Optional(Type.Union([
        Type.Literal('success'), Type.Literal('partial'),
        Type.Literal('failed'), Type.Literal('no-result'),
      ], { description: 'Task-report status filter (仅任务报告有 status)' })),
      severity: Type.Optional(Type.Union([
        Type.Literal('info'), Type.Literal('low'), Type.Literal('medium'),
        Type.Literal('high'), Type.Literal('critical'),
      ], { description: 'Vulnerability severity filter: info/low/medium/high/critical (仅漏洞有 severity)' })),
      q: Type.Optional(Type.String({
        description: 'Keyword substring matched against title/detail',
      })),
      before: Type.Optional(Type.Number({
        description: 'Pagination cursor: only entries with seq < before (pass the oldest seq of the current page to fetch the next older page)',
      })),
      limit: Type.Optional(Type.Number({
        description: 'Max entries shown, default 10, cap 50 (F35; total match count is always reported)',
      })),
    }),
    execute: async (_id, params) => {
      const rawWs = (caps.listBus?.() ?? [])
        .filter(e => e.workSessionId === (record.workSessionId ?? null));
      const isEntry = e => entryKind(e) !== null;
      // Fold: originals + their CURRENT (newest revision) versions.
      // Filters below see current titles/severities/status/detail.
      const inWs = foldRevisions(rawWs.filter(isEntry)).map(e => ({
        ...e,
        title: e.current.title ?? e.title,
        severity: e.current.severity ?? e.severity,
        status: e.current.status ?? e.status,
        detail: e.current.detail ?? e.detail,
        summary: e.current.summary ?? e.summary,
        // CS46-F2: 修订版 summary 顶替时截断标志同步顶替——否则原始条
        // 目的 summaryClipped 错标修订版(跨 500 界时'取全文/不可恢复'双向失真)。
        summaryClipped: e.current.summary ? Boolean(e.current.summaryClipped) : e.summaryClipped,
        void: Boolean(e.current.void),
        orphaned: Boolean(e.orphaned),
        revisedCount: e.revisedCount,
      }));
      const normKind = String(params.kind ?? 'both').toLowerCase();
      const kind = normKind === 'both' ? 'both'
        : (normKind === 'vulnerability' || normKind === 'vuln'
          || normKind === 'vulnerabilities') ? 'vulnerability'
        : (normKind === 'intel' || normKind === 'notes') ? 'intel-note' : 'task-report';
      const status = params.status ? String(params.status).toLowerCase() : null;
      const severity = params.severity ? String(params.severity).toLowerCase() : null;
      const q = params.q ? params.q.toLowerCase() : null;

      // Single-entry full fetch: no silent truncation anywhere.
      const extraFilters = (params.kind || params.q || params.author || params.agentType || params.status || params.severity) != null;
      if (params.seq != null) {
        const target = Number(params.seq);
        // A revision seq or its original both resolve to the CURRENT view.
        const orig = rawWs.find(x => x.seq === target);
        const viaRev = orig?.revises ? rawWs.find(x => x.seq === orig.revises) : null;
        const rootEntry = viaRev ?? orig;
        const e = rootEntry
          ? inWs.find(x => x.seq === rootEntry.seq) : null;
        if (!e) {
          return { content: [{ type: 'text', text: `seq=${params.seq} 在本项目内不存在。` }] };
        }
        const a = e.author;
        const prov = a ? `${a.name}(${a.typeLabel}${a.parent ? `,父:${a.parent.name}` : ''},L${a.depth})` : e.from;
        // Fix-F (P13): filters passed alongside seq are IGNORED — say so
        // inline and still return the body. The old notice claimed to
        // "return the full entry" while returning nothing (project-3:
        // agents burned a second call to actually fetch it).
        const note = extraFilters
          ? `(注:seq 模式下其它过滤参数已忽略,本条为 seq=${e.seq} 全文)\n` : '';
        const voidNote = e.void
          ? `\n[已作废——本条不再出现在常规查询中,仅存档审计]\n` : '';
        return { content: [{ type: 'text', text:
          `${note}[seq=${e.seq}] [${entryLabel(e)}] ${prov}${voidNote}\n` +
          `《${e.title ?? e.summary}》${e.payloadRef ? `\npayloadRef=${e.payloadRef}(read_session 可读源会话)` : ''}\n\n${e.detail ?? e.summary ?? ''}` }] };
      }

      const matched = inWs
        .filter(isEntry)
        .filter(e => !e.void)  // voided entries: audit-only, not for queries
        .filter(e => kind === 'both' || entryKind(e) === kind)
        .filter(e => !params.agentType || e.from === params.agentType)
        .filter(e => !status || e.status === status)
        .filter(e => !severity || (e.severity ?? '').toLowerCase() === severity)
        .filter(e => {
          if (!params.author) return true;
          const a = params.author.toLowerCase();
          return e.from === params.author || e.from.toLowerCase() === a
            || (e.author?.name ?? '').toLowerCase() === a;
        })
        .filter(e => {
          if (!q) return true;
          const hay = `${e.title ?? ''}\n${e.summary ?? ''}\n${e.detail ?? ''}`.toLowerCase();
          return hay.includes(q);
        })
        .sort((a, b) => b.seq - a.seq);
      // F35: 上限 20→50 + before 游标(翻页: 传 before=本页最旧 seq 取更旧一页)
      const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 50);
      const before = Number(params.before) || null;
      const paged = before ? matched.filter(e => e.seq < before) : matched;
      const hits = paged.slice(0, limit);
      const latestSeq = inWs.length ? Math.max(...inWs.map(e => e.seq)) : 0;
      const olderLeft = paged.length - hits.length;
      const countLine = `匹配 ${before ? `seq<${before} 内 ` : ''}${paged.length} 条${olderLeft > 0
        ? `,显示最新 ${hits.length} 条(续翻传 before=${hits[hits.length - 1].seq};单条全文传 seq)` : ''}(新→旧,库内最新 seq=${latestSeq}):`;

      if (hits.length === 0) {
        const scope = inWs.filter(e => isEntry(e) && !e.void);
        const reports = scope.filter(e => e.type === 'task-report').length;
        const vulns = scope.filter(e => entryKind(e) === 'vulnerability').length;
        const notes = scope.filter(e => entryKind(e) === 'intel-note').length;
        // F35: 提示只列真正在用的过滤维度——未传 q 不说"去掉 q"(误导排查)
        const relax = [];
        if (kind !== 'both') relax.push('kind');
        if (params.agentType) relax.push('agentType');
        if (status) relax.push('status');
        if (severity) relax.push('severity');
        if (params.author) relax.push('author');
        if (q) relax.push('q');
        const hasAny = reports + vulns + notes > 0;
        let hint = `无匹配条目。当前项目内:任务报告 ${reports} 条 / 漏洞 ${vulns} 条 / 情报 ${notes} 条。`;
        hint += relax.length
          ? (hasAny ? `当前过滤(${relax.join('/')})过窄,可放宽或去掉。` : `项目本身为空——过滤(${relax.join('/')})不是原因。`)
          : (hasAny ? '' : '项目尚无任何产出。');
        if (kind === 'vulnerability' && status) {
          hint += '\n注意:status 仅适用于任务报告;漏洞请用 severity 过滤。';
        }
        return { content: [{ type: 'text', text: hint }] };
      }
      const lines = hits.map(e => {
        const a = e.author;
        const prov = a
          ? `${a.name}(${a.typeLabel}${a.parent ? `,父:${a.parent.name}` : ''},L${a.depth})`
          : `${e.from}(溯源缺失)`;
        const head = e.type === 'task-report'
          ? `[seq=${e.seq}][任务报告|${e.status ?? '?'}] ${prov}`
          : entryKind(e) === 'vulnerability'
            ? `[seq=${e.seq}][漏洞|${e.severity ?? '?'}] ${prov}`
            : `[seq=${e.seq}][情报] ${prov}`;
        const hasDetail = Boolean(e.detail);
        const full = String(e.detail ?? e.summary ?? '');
        const body = full.slice(0, 400);
        // Never cut silently (repo rule): shown/total + 可行动补全手段
        // (AGENTS.md:39-44)。CS44-F2/CS45-N2: 消费 emit 的 summaryClipped
        // 标志分三态——detail 在=seq 可取全文; detail 缺+emit 已截=如实
        // 声明不可恢复; detail 缺+未截但本处超 400=seq 仍可取。
        let mark = '';
        if (full.length > 400) {
          if (hasDetail || !e.summaryClipped) {
            mark = `\n(正文 ${body.length}/${full.length} 字符,传 seq=${e.seq} 取全文)`;
          } else {
            mark = `\n(摘要 ${body.length}/500+ 字符,emit 已截断,seq 不可恢复,原文须 detail 通道重发)`;
          }
        }
        const voidTag = e.void ? '[已作废——本条不再出现在常规查询中]' : '';
        const revTag = e.revisedCount
          ? ` ⟳已修订${e.revisedCount}次(seq=${e.seq} 为原始条目,现行版为修订后的内容)` : '';
        return `${head}${revTag}${voidTag}\n《${e.title ?? e.summary}》${e.payloadRef ? ` payloadRef=${e.payloadRef}` : ''}\n${body}${mark}`;
      });
      return {
        content: [{
          type: 'text',
          text: clipMarked(`${countLine}\n\n${lines.join('\n\n---\n\n')}`,
            CONFIG.intelDigestChars, '可减小 limit 或用 q/author/status 过滤后分批查询'),
        }],
      };
    },
  };

  const submitTaskReport = {
    name: 'submit_task_report',
    label: '提交任务报告',
    description:
      '[creates event] File a task report into the project intel base. Dispatched tasks ' +
      '(spawn_agent / dispatch_agents) MUST file at least one report ' +
      'before finishing — even with zero vulns; multiple reports are ' +
      'fine for long or multi-stage tasks. Direct user conversations: ' +
      'file one when the user asks or when a meaningful unit of work ' +
      'concludes. Field values are MARKDOWN (lists/tables/code blocks ' +
      'allowed); the report renders as a markdown document — structure ' +
      'long content properly.',
    executionMode: 'sequential',
    parameters: Type.Object({
      title: Type.String({
        description: 'Report title summarizing the task (≤30 chars)',
      }),
      status: Type.Optional(Type.Union([
        Type.Literal('success'), Type.Literal('partial'),
        Type.Literal('failed'), Type.Literal('no-result'),
      ], {
        description: '必填建议:success=完成 / partial=部分完成 / failed=失败 / no-result=执行但无发现。遗漏时系统会按 outcome 推断并在回执注明',
      })),
      task: Type.String({ description: 'The task instruction you received (verbatim)' }),
      actions: Type.String({ description: 'What you did: steps, commands, coverage (markdown)' }),
      outcome: Type.String({
        description: 'Result; if failed, exactly why and where it stalled (markdown)',
      }),
      evidence: Type.Optional(Type.String({
        description: 'Key outputs / data / logs (markdown)',
      })),
      scope: Type.Optional(Type.String({
        description: 'Assets / platforms / environment touched',
      })),
      limits: Type.Optional(Type.String({
        description: 'Tool, permission or environment limitations',
      })),
      vulns: Type.Optional(Type.Array(Type.String(), {
        description: 'Titles of vulnerabilities produced in this run',
      })),
      nextSteps: Type.Optional(Type.String({
        description: 'Suggestions for downstream agents (markdown)',
      })),
    }),
    execute: async (_id, params) => {
      // Usability rule: never hard-reject when a sensible default exists.
      // status inference (reviewer-corrected order): failure words beat
      // everything; a non-empty outcome without them reads as success;
      // the safe fallback is partial — no-result asserts "ran, found
      // nothing", which a missing field cannot claim on the agent's behalf.
      let status = params.status ? String(params.status).toLowerCase() : null;
      let inferred = false;
      if (!status) {
        inferred = true;
        // F34: 推断收窄——描述性否定("未能确认/无法验证"是正常阴性结论,
        // 非"任务失败")曾把 no-result 报成 failed(编排对账实测踩中)。
        // 仅当失败词出现在任务定性位置(开头 40 字符或带"任务/执行/整体"前缀)才判 failed。
        const o = `${params.outcome ?? ''}\n${params.title ?? ''}`.toLowerCase();
        const outcomeHead = (params.outcome ?? '').trim().slice(0, 40).toLowerCase();
        status = (/^(任务|执行|整体)?(失败|failed)|超时|timeout/.test(outcomeHead)
            || /任务失败|执行失败|整体失败|operation failed/.test(o))
          ? 'failed'
          : /部分|partial|未完成/.test(o)
            ? 'partial'
            : (params.outcome ?? '').trim()
              ? 'success'
              : 'partial';
      }
      // Markdown document: blank-line-separated sections so multi-line
      // field values (tables/lists/code) never run into the next section.
      const section = (head, body) => (body ? `\n\n## ${head}\n${body}` : '');
      const vulnList = params.vulns?.length
        ? `- ${params.vulns.join('\n- ')}` : '';
      const detail = `**状态**:${status}` +
        section('任务', params.task) +
        section('行动', params.actions) +
        section('结果', params.outcome) +
        section('证据', params.evidence) +
        section('资产/环境', params.scope) +
        section('限制', params.limits) +
        section('产出漏洞', vulnList) +
        section('后续建议', params.nextSteps);
      record.taskReportCount += 1;
      record.lastReport = { title: params.title, status };
      const ev = caps.emitBus({
        channel: 'share', from: record.agentKey, type: 'task-report',
        author: caps.authorOf?.(record) ?? null,
        status,
        title: params.title,
        summary: `${status} · ${params.title}`,
        detail,
        payloadRef: `sess:${record.id}`,
        workSessionId: record.workSessionId ?? null,
        engagement: record.engagementId ? `autopwn-${record.engagementId}` : null,
      });
      // Dangling-reference check (warn-only): a vuln title with no
      // matching vulnerability entity starves downstream kind=vulnerability queries.
      const warnings = [];
      if (params.vulns?.length) {
        // R12-F4: 核对标题空间=查询展示空间——折修订取现行标题且滤
        // void(此前读原始事件: 作废漏洞仍算'已发布'悬空不告警; 引用
        // 旧标题与现行标题空间不一致)。
        const published = foldRevisions((caps.listBus?.() ?? [])
          .filter(e => e.workSessionId === (record.workSessionId ?? null)
            && entryKind(e) !== null))
          .filter(e => entryKind(e.current ?? e) === 'vulnerability'
            && !e.current.void)
          .map(e => normTitle(e.current.title ?? e.title));
        for (const t of params.vulns) {
          const nt = normTitle(t);
          const hit = published.some(p => p.includes(nt) || nt.includes(p));
          if (!hit) {
            warnings.push(`《${t}》在情报库未找到对应漏洞实体——若尚未发布请用 publish_vulnerability 发布,或从 vulns 中移除该引用`);
          }
        }
      }
      const note = inferred
        ? `(status 由系统推断为 ${status},如有误请再次提交修正)` : '';
      const warnText = warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : '';
      return {
        content: [{
          type: 'text',
          text: `任务报告已入库(seq=${ev?.seq ?? '?'})(${status})${note}:《${params.title}》。全项目智能体可经 query_intel 读取,revise_entry 修订请用此 seq。${warnText}`,
        }],
      };
    },
  };

  const reviseEntry = {
    name: 'revise_entry',
    label: '修订条目',
    description:
      '[creates event] Revise an intel note or task report by seq — ' +
      'any agent may revise any entry (shared working record); `reason` ' +
      'is mandatory and rides on the revision for audit. Only the ' +
      'fields you pass change; omitted fields keep their current ' +
      'values. The original is never overwritten (append-only chain, ' +
      'query_intel shows the current version). VULNERABILITY targets ' +
      'are rejected for non-writer agents — use ' +
      'request_vulnerability_revision (writer review) instead.',
    executionMode: 'sequential',
    parameters: Type.Object({
      seq: Type.Number({ description: 'Original entry seq to revise' }),
      reason: Type.String({ description: 'Why this revision (audited)' }),
      title: Type.Optional(Type.String({ description: 'New title (omit = keep)' })),
      severity: Type.Optional(Type.Union([
        Type.Literal('info'), Type.Literal('low'), Type.Literal('medium'),
        Type.Literal('high'), Type.Literal('critical'),
      ], { description: 'New severity, vulnerabilities only (omit = keep)' })),
      text: Type.Optional(Type.String({ description: 'New full content (omit = keep)' })),
      status: Type.Optional(Type.Union([
        Type.Literal('success'), Type.Literal('partial'), Type.Literal('failed'),
        Type.Literal('no-result'),
      ], { description: 'New status, task reports only (omit = keep)' })),
      void: Type.Optional(Type.Boolean({
        description: 'Mark the entry OBSOLETE — downstream queries exclude ' +
          'it by default; the chain stays visible for audit',
      })),
    }),
    execute: async (_id, params) => {
      const result = caps.reviseEntry?.(record, params);
      return { content: [{ type: 'text', text: result.text }],
        details: result.details ?? {} };
    },
  };

  const readSession = {
    name: 'read_session',
    label: '读取会话',
    description:
      '[read-only] Read the last N messages of a session by its ID ' +
      '(from payloadRef in intel results, or a sessionId from spawn_agent). ' +
      'Useful for reading the full original context behind a vulnerability ' +
      'or intel note or ' +
      'task report when the intel summary is not enough.',
    executionMode: 'sequential',
    parameters: Type.Object({
      sessionId: Type.String({
        description: 'Session ID (e.g. from payloadRef "sess:xxx" — strip the prefix)',
      }),
      last: Type.Optional(Type.Number({
        description: 'Number of recent messages to read, default 10, cap 30',
      })),
      full: Type.Optional(Type.Boolean({
        description: 'Raise per-message cap 300→8000 chars (still marked if clipped)',
      })),
    }),
    execute: async (_id, params) => {
      const sid = String(params.sessionId).replace(/^sess:/, '');
      const last = Math.min(Math.max(Number(params.last) || 10, 1), 30);
      // Access the session store via caps — injected by the composition root
      const messages = caps.readSessionMessages?.(sid, last, record.workSessionId ?? null);
      if (!messages) {
        return { content: [{ type: 'text',
          text: `会话 ${sid} 不存在或不可读。payloadRef 格式为 "sess:xxx",传 sessionId 时可带或不带前缀。` }] };
      }
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `会话 ${sid} 无消息。` }] };
      }
      // CS41-B1/CS44-F5: 单条截断直接调 clipMarked 单源(此前手搓标记
      // 差一前导空格; AGENTS 原则3)。
      // CS66-F1: 补全手段改工具内可行动 full 参数——此前指针指向
      // agent 不可达的内部令牌 API(且该端点同样 2000 截断, 双失实)。
      const cap = params.full ? 8000 : 300;
      const lines = messages.map(m => {
        const raw = m.text || '(无文本)';
        const who = m.role === 'user' ? '用户' : m.role === 'toolResult' ? '工具结果' : '智能体';
        return `${who}: ${clipMarked(raw, cap, '传 full: true 提高单条上限')}`;
      });
      return { content: [{ type: 'text',
        text: clipMarked(`会话 ${sid} 最近 ${messages.length} 条消息:\n\n${lines.join('\n\n---\n\n')}`,
          CONFIG.intelDigestChars, '可减小 last 参数') }] };
    },
  };

  return [submitTaskReport, queryIntel, readSession, reviseEntry];
}

/**
 * report_vulnerability — the DISCOVERER-side tool. One sentence in;
 * a dedicated report-writer session does the rest (reads the caller's
 * transcript, cross-validates, then publishes or declines). Registered
 * for child + non-report direct sessions; NOT for the writer itself
 * (no recursion). Synchronous: the receipt lands when the writer ends.
 * [runs writer; synchronous] [idempotent: no]  CS64-1: 简式对齐 AGENTS.md 表
 */
function buildReportVulnerabilityTool(record, caps) {
  return {
    name: 'report_vulnerability',
    label: '上报漏洞线索',
    description:
      '[runs writer; synchronous — may take minutes] ' +
      'Report a suspected submittable vulnerability in ONE sentence. A ' +
      'dedicated report-writer agent will read YOUR conversation context ' +
      '(and any other sessions / intel it needs), verify the claim, and ' +
      'either publish the formal vulnerability record (it decides title ' +
      'and severity) or decline with reasons. You get the verdict in the ' +
      'tool receipt. Do NOT write the report yourself — the hint sentence ' +
      'plus your transcript evidence is all the writer needs.',
    executionMode: 'sequential',
    parameters: Type.Object({
      hint: Type.String({
        description: 'One sentence describing the vulnerability: target, ' +
          'flaw, and why it matters, e.g. "Grafana at x.example.com ' +
          'accepts default admin/admin credentials"',
      }),
    }),
    execute: async (_id, params) => {
      if (!caps.reportWriter) {
        return { content: [{ type: 'text',
          text: '报告撰写服务不可用(capability 缺失)。可用 publish_intel 留存线索。' }] };
      }
      const result = await caps.reportWriter(record, params.hint);
      return {
        content: [{ type: 'text', text: result.text }],
        details: result.details ?? {},
      };
    },
  };
}

/**
 * request_vulnerability_revision — writer-reviewed vulnerability
 * revision request (child + non-report direct sessions). Synchronous,
 * same wake/wait/verdict pattern as report_vulnerability.
 */
function buildRequestRevisionTool(record, caps) {
  return {
    name: 'request_vulnerability_revision',
    label: '申请漏洞修订',
    description:
      '[runs writer; synchronous — may take minutes] ' +
      'Request a revision of a PUBLISHED vulnerability. A writer agent ' +
      'reviews the original report plus your request, verifies necessity ' +
      'AND correctness, then either lands the revision (it decides the ' +
      'final fields) or declines with reasons. The verdict returns in ' +
      'this receipt. Vulnerabilities are never revised without writer ' +
      'review.',
    executionMode: 'sequential',
    parameters: Type.Object({
      seq: Type.Number({ description: 'Original vulnerability seq' }),
      reason: Type.String({ description: 'Why the revision is necessary' }),
      changes: Type.String({
        description: 'What should change and to what (free text — the ' +
          'writer constructs the final fields)',
      }),
    }),
    execute: async (_id, params) => {
      if (!caps.revisionWriter) {
        return { content: [{ type: 'text',
          text: '漏洞修订服务不可用(capability 缺失)。' }] };
      }
      const result = await caps.revisionWriter(record, params.seq,
        params.reason, params.changes);
      return { content: [{ type: 'text', text: result.text }],
        details: result.details ?? {} };
    },
  };
}

/**
 * Shared spawn_agent tool — registered in BOTH the orchestrator and the
 * child tool sets (identical definition; extracted to prevent drift).
 * [spawns agent] [idempotent: no]  CS63-F2: 与描述首词/AGENTS.md 表同形
 */
function buildSpawnAgentTool(record, caps) {
  return {
    name: 'spawn_agent',
    label: '派生子智能体',
    description:
      '[spawns agent] Spawn a sub-agent under YOU in the dispatch tree. Any stage agent or ' +
      'a sub-orchestrator (agentKey "autopwn" gets full scheduling powers ' +
      'and works for you). The spawned agent runs the instruction and ' +
      'reports back to you via [DM] when finished. Depth and total-agent ' +
      'limits are enforced; explain failures to the user if blocked.',
    executionMode: 'sequential',
    parameters: Type.Object({
      agentKey: Type.Union([
        spawnStageEnum,
        Type.Literal('autopwn'),
      ], {
        description: 'Agent to spawn; "autopwn" = sub-orchestrator ' +
          '(report agent is not spawnable — use report_vulnerability)',
      }),
      name: Type.String({
        maxLength: 20,
        description: 'Codename for the spawned agent that reflects its ' +
          'task, e.g. "边界测绘一组" (short, ≤20 chars)',
      }),
      description: Type.String({
        maxLength: 60,
        description: 'One short sentence describing the agent\'s ' +
          'function/mission (≤60 chars)',
      }),
      instruction: Type.String({
        description: 'Complete task instruction for the spawned agent',
      }),
    }),
    execute: async (_id, params) => {
      // Fix-H (A3): codename IS provenance (spawnName feeds authorOf,
      // DMs, tree paths) — enforce the documented ≤20/≤60 contract with
      // an actionable refusal instead of the store's silent slice.
      // CS42-F4 同步钉注: 本面 20/60 与 sessions.mjs SESSION_NAME_MAX/
      // SESSION_DESC_MAX 同值(本文件被 sessions.mjs 反向 import, 不能
      // 引其常量——改任一侧必须同步另一侧, 先例 CS23-N15)。
      if (String(params.name).length > 20) {
        return { content: [{ type: 'text',
          text: `派生被拒绝:代号超长(${String(params.name).length}/20 字符),请精简后重试。` }] };
      }
      if (String(params.description).length > 60) {
        return { content: [{ type: 'text',
          text: `派生被拒绝:描述超长(${String(params.description).length}/60 字符),请精简后重试。` }] };
      }
      const verdict = caps.spawnCheck(record, params.agentKey);
      if (!verdict.ok) {
        return {
          content: [{
            type: 'text',
            text: `派生被拒绝:${verdict.reason}`,
          }],
          details: verdict,
        };
      }
      const spawned = await caps.spawnChild(record, params.agentKey,
        params.instruction, { name: params.name, description: params.description });
      return {
        content: [{
          type: 'text',
          text: `已派生 ${params.name}(${params.agentKey} ${spawned.id},深度 ${verdict.depth}),` +
            '完成后会以 [DM] 向你回报结果。',
        }],
        details: { sessionId: spawned.id, depth: verdict.depth },
      };
    },
  };
}

/** @param {object} record  session record (holds activeEngagement)
 * @param {object} caps    { dispatch, signalEngagement, emitBus } */
export function buildOrchestratorTools(record, caps) {
  const dispatchAgents = {
    name: 'dispatch_agents',
    label: '调度子智能体',
    description:
      '[starts engagement] Dispatch a pentest objective to stage agents. They run in parallel ' +
      'inside a durable Temporal engagement and share results over the bus.',
    executionMode: 'sequential',
    parameters: Type.Object({
      instruction: Type.String({
        description: 'Full task instruction for the stage agents',
      }),
      agents: Type.Array(stageEnum, {
        description: 'Stage agent keys to dispatch, e.g. ["recon","nday"]',
      }),
    }),
    execute: async (_id, params) => {
      // Fix-B (A1): quota applies to BOTH dispatch entry points. A batch
      // that would push the tree past the cap is refused up front — the
      // project-3 lockout started exactly here (7+3=10>8 accepted).
      const verdict = caps.dispatchCheck?.(record, params.agents.length)
        ?? { ok: true };
      if (!verdict.ok) {
        return {
          content: [{ type: 'text', text: `派发被拒绝:${verdict.reason}` }],
          details: verdict,
        };
      }
      const started = await caps.dispatch({
        instruction: params.instruction,
        agents: [...params.agents],
        orchestratorSessionId: record.id,
        workSessionId: record.workSessionId ?? null,
      });
      record.activeEngagement = started;
      return {
        content: [{
          type: 'text',
          text: `Engagement ${started.engagementId} started; agents ` +
            `${started.agents.join(', ')} running. Results will be ` +
            `reported to you as [DM] messages — relay them with ` +
            `relay_to_agents when other agents need to know.`,
        }],
        details: started,
      };
    },
  };

  const relayToAgents = {
    name: 'relay_to_agents',
    label: '转发情报',
    description:
      '[sends DM] Relay a message to specific stage agents of your active engagement ' +
      '(or an explicit engagementId). Use when a child report warrants it.',
    executionMode: 'sequential',
    parameters: Type.Object({
      agents: Type.Array(stageEnum, {
        // Fix-E (P7): empty array sailed through schema and produced
        // the lying receipt "Relayed to  (…)".
        minItems: 1,
        description: 'Target stage agent keys (members of the engagement)',
      }),
      text: Type.String({ description: 'Message to relay' }),
      engagementId: Type.Optional(Type.String({
        description: 'Defaults to the engagement started last',
      })),
    }),
    execute: async (_id, params) => {
      const engagement = params.engagementId
        ? `autopwn-${params.engagementId.replace(/^autopwn-/, '')}`
        : record.activeEngagement?.workflowId;
      if (!engagement) {
        // CS41-B6: 结构化可行动回执(同函数其余失败分支制式——此前裸
        // throw 产原始异常栈); CS42-F7: details 对齐(按 details.relayed
        // 消费的调用方此分支不再漏检)。
        return { content: [{ type: 'text',
          text: '转发失败:无进行中的 engagement——先调用 dispatch_agents 发起战役再转发。' }],
          details: { engagement: null, agents: params.agents, relayed: false, reason: 'no-engagement' } };
      }
      // Fix-E (P7): membership validation BEFORE signaling. Implicit path
      // reads the persisted activeEngagement.agents; explicit path derives
      // members from the session store. When no member list can be
      // resolved, SKIP the check (degrade to old behavior) — refusing all
      // targets on a missing list would be worse than the status quo.
      const members = params.engagementId
        ? (caps.engagementMembers?.(params.engagementId.replace(/^autopwn-/, '')) ?? [])
        : (record.activeEngagement?.agents ?? []);
      if (members.length) {
        const invalid = params.agents.filter(k => !members.includes(k));
        if (invalid.length) {
          return {
            content: [{
              type: 'text',
              text: `未转发:${invalid.join(',')} 不在 ${engagement} 成员列表` +
                `(成员:${members.join(',')})。请核对 agents 参数。`,
            }],
            details: { engagement, agents: params.agents, relayed: false, invalid },
          };
        }
      }
      try {
        await caps.signalEngagement(engagement, 'orchestratorRelay', {
          to: [...params.agents],
          text: params.text,
        });
      } catch {
        // Fix-J (P8): distinguish "never existed" from "already finished"
        // via describeWorkflow instead of matching Temporal's server-side
        // English error string (unstable across versions). No more
        // "已结束" lies about workflows that were never created.
        let why = '已结束,子智能体均已停止。';
        try {
          const desc = await caps.describeEngagement?.(engagement);
          if (!desc) {
            why = '已结束,子智能体均已停止。';
          } else if (desc.status === 'RUNNING') {
            why = '投递信号失败(engagement 仍在运行,可重试)。';
          }
        } catch {
          why = '不存在(id 有误或从未创建)。';
        }
        return {
          content: [{
            type: 'text',
            text: `未转发:${engagement} ${why}`,
          }],
          details: { engagement, agents: params.agents, relayed: false },
        };
      }
      for (const key of params.agents) {
        caps.emitBus({
          channel: 'dm', from: 'orchestrator', to: key, type: 'relay',
          summary: `转发情报:${params.text.slice(0, 120)}`,
          engagement,
          workSessionId: record.workSessionId ?? null,
        });
      }
      return {
        content: [{
          type: 'text',
          text: `Relayed to ${params.agents.join(', ')} (${engagement}).`,
        }],
        details: { engagement, agents: params.agents },
      };
    },
  };

  const spawnAgent = buildSpawnAgentTool(record, caps);

  return [dispatchAgents, relayToAgents, spawnAgent];
}

/**
 * Shell tool — operate C2 implant handles handed over by the C2 agent or
 * the operator (SSH-like channel over the compromise). Same tool instance
 * per agent (independence axiom): c2 (register+handoff), persistence and
 * postex (operate), autopwn (relay/verify). Server-side scope gate refuses
 * out-of-window/out-of-target shells — tool-level defense mirrors it.
 */
export function buildShellTools(record, caps) {
  if (!caps?.shells) return [];
  const sh = {
    name: 'shell',
    label: 'Shell 通道',
    description:
      '[runs commands; side-effects] 操作 C2 植入产生的 shell 通道(经授权门)。' +
      'action=list 列出可用 shell(含 id/目标/系统指纹/任务数);action=exec 执行命令并返回' +
      ' stdout/stderr/退出码;action=read_file 读文件;action=status 看 shell 元数据+最近任务;' +
      'action=close 关闭。每条命令进平台审计(证据链)。shell 可由 c2 agent 交付或运营注册,' +
      '在智能体间通过 id 传递(情报/任务指令中携带 shellId)。',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'), Type.Literal('register'), Type.Literal('exec'),
        Type.Literal('read_file'), Type.Literal('status'), Type.Literal('close'),
      ], { description: 'list / register(把已验证通道自注册进审计体系) / exec / read_file / status / close' }),
      name: Type.Optional(Type.String({ description: 'register: 通道名(唯一,建议 目标-面-权限 如 dc8-web-www);list 时可作名称子串过滤' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'register: 标签(≤8,如 ["web","www","entry"])' })),
      filterTarget: Type.Optional(Type.String({ description: 'list: 按授权目标过滤' })),
      filterTransport: Type.Optional(Type.String({ description: 'list: 按传输过滤(local/ssh/web)' })),
      filterTag: Type.Optional(Type.String({ description: 'list: 按标签过滤' })),
      target: Type.Optional(Type.String({ description: 'register: 授权目标名(须在 scope 清单)' })),
      transport: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('ssh'), Type.Literal('web')],
        { description: 'register: local|ssh|web' })),
      transportRef: Type.Optional(Type.String({
        description: 'register: 通道定义——local: "容器名[:用户]"; ssh: "user:pass@host:port"; web: URL 模板含 {CMD}(GET 或 POST|url|body),可加 "#MARK" 响应定界(只取 <MARK>..</MARK> 之间,消页面噪声)' })),
      shellId: Type.Optional(Type.String({ description: 'shell id(sh-xxx);list 可省' })),
      command: Type.Optional(Type.String({ description: 'exec:要执行的命令' })),
      timeoutMs: Type.Optional(Type.Number({ description: 'exec:硬超时毫秒(默认 30000,web 通道强制硬杀)' })),
      path: Type.Optional(Type.String({ description: 'read_file:绝对路径' })),
    }),
    execute: async (_id, p) => {
      // pi tool protocol: results must be content-block envelopes.

      const say = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
      const R = caps.shells;
      // CS41-B3: action 入口归一化(AGENTS 原则5——同 execute 的 transport
      // 归一, 此前大小写敏感裸匹配旁路)。
      p.action = String(p.action ?? '').toLowerCase();
      try {
        if (p.action === 'list') {
          const list = R.list({ target: p.filterTarget, transport: p.filterTransport,
            tag: p.filterTag, name: p.name, status: 'active' })
            .map(x => ({ id: x.id, name: x.name, target: x.target, transport: x.transport,
              tags: x.tags ?? [], status: x.status, user: x.user, os: (x.os || '').slice(0, 60),
              cmdCount: x.cmdCount, expiresAt: x.expiresAt }));
          return say(list.length ? { ok: true, count: list.length, shells: list }
            : { ok: true, count: 0, shells: [], note: '无匹配 shell——放宽过滤或查情报库 shell-ready;注册用 register' });
        }
        if (p.action === 'register') {
          if (!p.transportRef || !p.target) return say({ ok: false, error: 'register 需 transportRef+target' });
          const sh = R.register({
            name: p.name, target: p.target,
            transport: String(p.transport ?? 'web').toLowerCase(),  // CS25-N3: 入口归一化(AGENTS 原则5; 'Web'/'LOCAL' 变体不再硬拒)
            transportRef: p.transportRef,
            tags: p.tags, note: 'agent 自注册(' + (record.agentKey || 'agent') + ')',
            createdBy: record.agentKey || 'agent',
          });
          if (sh?.error) return say({ ok: false, error: sh.error });
          await R.fingerprint?.(sh.id).catch?.(() => {});
          return say({ ok: true, shell: sh, note: '已注册并进审计体系;后续 exec/read_file 用 shellId=' + sh.id });
        }
        if (!p.shellId) return say({ ok: false, error: 'shellId 必填' });
        if (p.action === 'exec') {
          if (!p.command) return say({ ok: false, error: 'command 必填' });  // R12-F2
          const r = await R.exec(p.shellId, p.command, { timeoutMs: Math.min(p.timeoutMs || 30_000, 120_000) });
          return say({ ...r,
            stdout: markClipped(r.stdout, 8000, '管道 head/tail/grep 缩小后重取'),
            stderr: markClipped(r.stderr, 2000, '重定向到文件后分段读') });  // R12-F3
        }
        if (p.action === 'read_file') {
          if (!p.path) return say({ ok: false, error: 'path 必填' });  // R12-F2
          const r = await R.readFile(p.shellId, p.path);
          return say({ ok: r.ok,
            content: markClipped(r.stdout, 16000, '重读用 tail -c +N 分段取'), code: r.code });  // R12-F3
        }
        if (p.action === 'status') {
          const g = R.get(p.shellId);
          if (!g) return say({ ok: false, error: 'shell 不存在' });
          return say({ ok: true, shell: { ...g, tasks: (g.tasks ?? []).slice(-10) } });
        }
        if (p.action === 'close') return say(R.close(p.shellId));
        return say({ ok: false, error: '未知 action' });
      } catch (e) {
        return say({ ok: false, error: 'shell 工具异常: ' + e.message });
      }
    },
  };
  return [sh];
}

/** R12-F3 helper: slice 截断必附标记。真模块级——此前误嵌在 shell 工具
 * execute 闭包体内零缩进(CS1-B11), 同时破坏全文件缩进。 */
function markClipped(text, cap, how) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n[已截断:${cap}/${s.length} 字符,${how}]`  // CS44-F5: 逗号单源制式;
}

/** Bus-entry kind normalization. Legacy WAL data carries vulnerability events
 * as type='intel' (pre-rename) — they ARE vulnerabilities now; new
 * intel notes use 'intel-note' to avoid the collision. */
export function entryKind(e) {
  if (e.type === 'vulnerability' || e.type === 'intel') return 'vulnerability';
  if (e.type === 'intel-note') return 'intel-note';
  if (e.type === 'task-report') return 'task-report';
  return null;
}

function entryLabel(e) {
  const k = entryKind(e);
  if (k === 'vulnerability') return `漏洞|${e.severity ?? '?'}`;
  if (k === 'intel-note') return '情报';
  if (k === 'task-report') return `任务报告|${e.status ?? '?'}`;
  return e.type ?? '?';
}

/**
 * buildPublishIntelTool (CS1-R15/C2/D2): engagement child 与 direct 两处
 * ~30 行逐字双胞胎抽共享工厂(AGENTS.md ≥20 行规则; spawn_agent 已树
 * 先例)。差异仅: 总线 to/origin、DM 通知、描述详略。
 * @param {object} record   session record
 * @param {object} caps     { emitBus, followUp?, authorOf? }
 * @param {{to: 'orchestrator'|'user', origin: 'engagement'|'direct',
 *          dm: boolean, verbose: boolean}} mode
 */
function buildPublishIntelTool(record, caps, mode) {
  const dm = mode.dm;
  return {
    name: 'publish_intel',
    label: '发布情报',
    description:
      '[creates event] ' + (mode.verbose
        ? 'Publish an INTEL NOTE — any information that might help '
        + 'the task: observed behavior, credentials/leaks worth trying, '
        + 'interesting endpoints, environment details, partial leads, '
        + 'attack-surface hypotheses. Low bar by design: if it could plausibly '
        + 'help ANY agent in this project, publish it. Confirmed real-harm '
        + 'submittable vulnerabilities go to publish_vulnerability, NOT here. '
        + 'Visible to every agent (query_intel kind=intel) and the 情报 panel.'
        : 'Record an INTEL NOTE from this conversation into the '
        + '情报 panel — any information that might help the task (leads, '
        + 'observations, environment details, hypotheses). Confirmed submittable '
        + 'vulnerabilities go to publish_vulnerability instead.'),
    executionMode: 'sequential',
    parameters: Type.Object({
      title: Type.String({ description: 'One-line intel title' }),
      text: Type.String({
        description: 'Intel content (markdown): what was observed, why it may matter.',
      }),
    }),
    execute: async (_id, params) => {
      const engagement = record.engagementId ? `autopwn-${record.engagementId}` : null;
      caps.emitBus({
        channel: 'dm', from: record.agentKey, to: mode.to,
        type: 'intel-note',
        title: params.title,
        summary: params.title,
        detail: params.text,
        origin: mode.origin,
        author: caps.authorOf?.(record) ?? null,
        workSessionId: record.workSessionId ?? null,
        ...(engagement ? { engagement } : {}),
      });
      if (dm) {
        const dmTarget = record.orchestratorSessionId ?? record.parentSessionId;
        if (dmTarget) {
          await caps.followUp(
            dmTarget,
            `[DM from ${record.agentKey}] [情报] ${params.title}\n` +
            `${params.text}\n` +
            '(如其他智能体需要知情,用 relay_to_agents 转发;否则继续等待产出)',
          );
        }
      }
      return {
        content: [{
          type: 'text',
          text: `情报已入库: ${params.title}`,
        }],
      };
    },
  };
}

/**
 * @param {object} record  engagement child session record
 * @param {object} caps    { signalEngagement, emitBus, followUp }
 */
export function buildChildTools(record, caps) {
  const publishIntel = buildPublishIntelTool(record, caps,
    { to: 'orchestrator', origin: 'engagement', dm: true, verbose: true });
  const spawnAgent = buildSpawnAgentTool(record, caps);

  return [buildReportVulnerabilityTool(record, caps), publishIntel,
    buildRequestRevisionTool(record, caps), spawnAgent];
}

/**
 * Direct (non-engagement) user sessions. A 'report' session IS the
 * writer: it holds publish_vulnerability (plus the user can drive it
 * from the console nav). Every other direct session delegates
 * vulnerability writing to the writer via report_vulnerability.
 *
 * @param {object} record  direct session record
 * @param {object} caps    { emitBus, reportWriter, authorOf }
 */
export function buildDirectTools(record, caps) {
  const publishVuln = {
    name: 'publish_vulnerability',
    label: '发布漏洞',
    description:
      '[creates event] Record a VULNERABILITY from this conversation into ' +
      'the 漏洞 panel (visible to every agent via query_intel). ONLY ' +
      'confirmed, real-harm, submittable vulnerabilities — speculative or ' +
      'merely useful info goes to publish_intel. Call once per distinct ' +
      'vulnerability — do not re-publish. You may still submit task ' +
      'reports separately; this tool only records vulnerabilities.',
    executionMode: 'sequential',
    parameters: Type.Object({
      title: Type.String({ description: 'One-line vulnerability title' }),
      text: Type.String({ description: 'Full vulnerability write-up: 发现过程、证据链、危害分析、复现要点 (markdown)' }),
      severity: Type.Union([
        Type.Literal('info'), Type.Literal('low'), Type.Literal('medium'),
        Type.Literal('high'), Type.Literal('critical'),
      ], { description: 'Vulnerability severity: info/low/medium/high/critical' }),
    }),
    execute: async (_id, params) => {
      caps.emitBus({
        channel: 'dm', from: record.agentKey, to: 'user',
        type: 'vulnerability',
        // Writer provenance: the vuln panel's "撰写对话" button and the
        // discoverer attribution ride on these two fields.
        payloadRef: `sess:${record.id}`,
        ...(record.requester ? { requester: record.requester.author } : {}),
        severity: String(params.severity).toLowerCase(),
        title: params.title,
        summary: params.title,
        detail: params.text,
        origin: 'direct',
        author: caps.authorOf?.(record) ?? null,
        workSessionId: record.workSessionId ?? null,
      });
      return {
        content: [{
          type: 'text',
          text: `漏洞已入库 (${String(params.severity).toLowerCase()}): ${params.title}`,
        }],
      };
    },
  };

  const publishIntel = buildPublishIntelTool(record, caps,
    { to: 'user', origin: 'direct', dm: false, verbose: false });

  if (record.agentKey === 'report') {
    // R31: report(writer)原 early-return 无 tooling 实例——撰写引用/
    // CVE 背景核验需要各持独立 search_web/fetch_url(共享工具铁律;
    // report 席位实测"search_web 终审缺席")。
    return [publishVuln, publishIntel,
      ...buildToolingTools({ agentKey: record.agentKey }, caps)];
  }
  // 共享工具铁律(AGENTS.md): 多智能体都需要的能力(如联网搜索/抓取)
  // = 每个业务智能体各持独立实例, 不共享不缺席。此前仅 recon/nday 拼
  // 装工具面, 其余业务 agent(api/exploit/weakcred/phish/c2/persistence/
  // postex)搜索/抓取链完全不可达(api agent 实测反馈"search_web 未注册",
  // 与旧注释"search_web stays config-only"同源于铁律冲突——按铁律修正)。
  // report(writer)保持纯撰写面不扩张。
  return [buildReportVulnerabilityTool(record, caps), publishIntel,
    buildRequestRevisionTool(record, caps),
    ...buildToolingTools({ agentKey: record.agentKey }, caps)];
}
/**
 * Case/punct-insensitive title match for dangling-reference checks
 * (悬空漏洞引用模糊匹配). CS4-M5: 模块级导出——tests/norm-title.test.mjs
 * 锁真实现(此前测试锁逐字副本, 实现回归时测试仍绿)。
 */
export const normTitle = s => String(s ?? '').toLowerCase()
  .replace(/[\s·,。,.;:;:()[\]()（）【】《》""''-]/g, '');
