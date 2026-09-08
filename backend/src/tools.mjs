/**
 * Session-scoped agent tools.
 *
 * Tools are built per-session (they close over the session record) and
 * receive a `caps` capability bag injected by the composition root, so this
 * module never imports Temporal or the bus directly — the architecture rule
 * "worker/runtime only meet through injected capabilities" holds.
 *
 * Tool matrix (LLM-facing; usability rule: one obvious tool per intent,
 * never a hard reject when a sensible default exists):
 *   orchestrator session  → dispatch_agents, relay_to_agents, spawn_agent, submit/query
 *   engagement/spawn child→ publish_finding, spawn_agent, submit/query
 *   direct user session   → publish_finding, submit/query
 */

import { Type } from '@earendil-works/pi-ai';

import { CONFIG } from './config.mjs';
import { clipMarked } from './pi.mjs';

const STAGE_KEYS = [
  'recon', 'nday', 'weakcred', 'api', 'exploit',
  'phish', 'c2', 'persistence', 'postex', 'report',
];

const stageEnum = Type.Enum(
  Object.fromEntries(STAGE_KEYS.map((key) => [key, key])),
);

/**
 * Shared intel tools — the project intel base every agent reads and
 * writes. Task reports are the PROCESS record (mandatory at every quiet
 * point, even with zero findings); FINDINGs are the RESULT record,
 * published via publish_finding. Both live on the bus with frozen
 * provenance, readable by any agent in the same work session.
 *
 * @param {object} record  session record (run counters live here)
 * @param {object} caps    { emitBus, authorOf, listBus }
 */
export function buildIntelTools(record, caps) {
  /** Case/punct-insensitive title match for dangling-reference checks. */
  const normTitle = s => String(s ?? '').toLowerCase()
    .replace(/[\s·,。,.;:;:()\[\]()【】《》"'\'\"-]/g, '');
  const queryIntel = {
    name: 'query_intel',
    label: '查询情报',
    description:
      '[read-only] Read FINDINGs and task reports published by ANY agent in this ' +
      'project — the orchestrator, siblings, or yourself. Helpful whenever ' +
      'you need context you do not have: targets, platforms, credentials, ' +
      'scope (e.g. before writing platform-specific malware, check the ' +
      'recon agent\'s reports), or the full details of a finished child\'s ' +
      'output. Pass `seq` (from a previous result) to fetch ONE entry in ' +
      'full detail.',
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([
        Type.Literal('task-report'), Type.Literal('finding'), Type.Literal('both'),
        Type.Literal('reports'), Type.Literal('findings'), Type.Literal('task_report'),
      ], { description: 'Intel kind: task-report(=reports) / finding(=findings) / both. Default both' })),
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
      ], { description: 'FINDING severity filter: info/low/medium/high/critical (仅 FINDING 有 severity)' })),
      q: Type.Optional(Type.String({
        description: 'Keyword substring matched against title/detail',
      })),
      limit: Type.Optional(Type.Number({
        description: 'Max entries shown, default 10, cap 20 (total match count is always reported)',
      })),
    }),
    execute: async (_id, params) => {
      const inWs = (caps.listBus?.() ?? [])
        .filter(e => e.workSessionId === (record.workSessionId ?? null));
      const normKind = String(params.kind ?? 'both').toLowerCase();
      const kind = normKind === 'both' ? 'both'
        : (normKind === 'finding' || normKind === 'findings') ? 'finding' : 'task-report';
      const status = params.status ? String(params.status).toLowerCase() : null;
      const severity = params.severity ? String(params.severity).toLowerCase() : null;
      const q = params.q ? params.q.toLowerCase() : null;

      // Single-entry full fetch: no silent truncation anywhere.
      const extraFilters = (params.kind || params.q || params.author || params.agentType || params.status || params.severity) != null;
      if (params.seq != null) {
        const e = inWs.find(x => x.seq === Number(params.seq)
          && (x.type === 'intel' || x.type === 'task-report'));
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
        return { content: [{ type: 'text', text:
          `${note}[seq=${e.seq}] [${e.type === 'task-report' ? `任务报告|${e.status}` : `FINDING|${e.severity}`}] ${prov}\n` +
          `《${e.title ?? e.summary}》${e.payloadRef ? `\npayloadRef=${e.payloadRef}(read_session 可读源会话)` : ''}\n\n${e.detail ?? e.summary ?? ''}` }] };
      }

      const matched = inWs
        .filter(e => e.type === 'intel' || e.type === 'task-report')
        .filter(e => kind === 'both' || e.type === (kind === 'finding' ? 'intel' : 'task-report'))
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
      const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 20);
      const hits = matched.slice(0, limit);
      const latestSeq = inWs.length ? Math.max(...inWs.map(e => e.seq)) : 0;
      const countLine = `匹配 ${matched.length} 条${matched.length > hits.length
        ? `,显示最新 ${hits.length} 条(可用 seq 取单条全文)` : ''}(新→旧,库内最新 seq=${latestSeq}):`;

      if (hits.length === 0) {
        const scope = inWs.filter(e => e.type === 'intel' || e.type === 'task-report');
        const reports = scope.filter(e => e.type === 'task-report').length;
        const findings = scope.filter(e => e.type === 'intel').length;
        let hint = `无匹配情报。当前项目内:任务报告 ${reports} 条 / FINDING ${findings} 条。可尝试放宽 kind/status/author 或去掉 q。`;
        if (kind === 'finding' && status) {
          hint += '\n注意:status 仅适用于任务报告;FINDING 请用 severity 过滤。';
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
          : `[seq=${e.seq}][FINDING|${e.severity ?? '?'}] ${prov}`;
        const full = String(e.detail ?? e.summary ?? '');
        const body = full.slice(0, 400);
        // Never cut silently (repo rule): mark per-entry truncation and
        const mark = full.length > 400
          ? `\n(正文 ${body.length}/${full.length} 字符,传 seq=${e.seq} 取全文)` : '';
        return `${head}\n《${e.title ?? e.summary}》${e.payloadRef ? ` payloadRef=${e.payloadRef}` : ''}\n${body}${mark}`;
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
      'before finishing — even with zero findings; multiple reports are ' +
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
      findings: Type.Optional(Type.Array(Type.String(), {
        description: 'Titles of FINDINGs produced in this run',
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
        const o = `${params.outcome ?? ''}\n${params.title ?? ''}`.toLowerCase();
        status = /失败|无法|未能|没?有成功|failed|error|超时|timeout/.test(o)
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
      const findingList = params.findings?.length
        ? `- ${params.findings.join('\n- ')}` : '';
      const detail = `**状态**:${status}` +
        section('任务', params.task) +
        section('行动', params.actions) +
        section('结果', params.outcome) +
        section('证据', params.evidence) +
        section('资产/环境', params.scope) +
        section('限制', params.limits) +
        section('产出 FINDING', findingList) +
        section('后续建议', params.nextSteps);
      record.taskReportCount += 1;
      record.lastReport = { title: params.title, status };
      caps.emitBus({
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
      // Dangling-reference check (warn-only): a findings title with no
      // matching FINDING entity starves downstream kind=finding queries.
      const warnings = [];
      if (params.findings?.length) {
        const published = (caps.listBus?.() ?? [])
          .filter(e => e.workSessionId === (record.workSessionId ?? null)
            && e.type === 'intel')
          .map(e => normTitle(e.title));
        for (const t of params.findings) {
          const nt = normTitle(t);
          const hit = published.some(p => p.includes(nt) || nt.includes(p));
          if (!hit) {
            warnings.push(`《${t}》在情报库未找到对应 FINDING 实体——若尚未发布请用 publish_finding 发布该发现,或从 findings 中移除该引用`);
          }
        }
      }
      const note = inferred
        ? `(status 由系统推断为 ${status},如有误请再次提交修正)` : '';
      const warnText = warnings.length ? `\n⚠️ ${warnings.join('\n⚠️ ')}` : '';
      return {
        content: [{
          type: 'text',
          text: `任务报告已入库(${status})${note}:《${params.title}》。全项目智能体可经 query_intel 读取。${warnText}`,
        }],
      };
    },
  };


  const readSession = {
    name: 'read_session',
    label: '读取会话',
    description:
      '[read-only] Read the last N messages of a session by its ID ' +
      '(from payloadRef in intel results, or a sessionId from spawn_agent). ' +
      'Useful for reading the full original context behind a FINDING or ' +
      'task report when the intel summary is not enough.',
    executionMode: 'sequential',
    parameters: Type.Object({
      sessionId: Type.String({
        description: 'Session ID (e.g. from payloadRef "sess:xxx" — strip the prefix)',
      }),
      last: Type.Optional(Type.Number({
        description: 'Number of recent messages to read, default 10, cap 30',
      })),
    }),
    execute: async (_id, params) => {
      const sid = String(params.sessionId).replace(/^sess:/, '');
      const last = Math.min(Math.max(Number(params.last) || 10, 1), 30);
      // Access the session store via caps — injected by the composition root
      const messages = caps.readSessionMessages?.(sid, last);
      if (!messages) {
        return { content: [{ type: 'text',
          text: `会话 ${sid} 不存在或不可读。payloadRef 格式为 "sess:xxx",传 sessionId 时可带或不带前缀。` }] };
      }
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: `会话 ${sid} 无消息。` }] };
      }
      const lines = messages.map(m =>
        `${m.role === 'user' ? '用户' : m.role === 'toolResult' ? '工具结果' : '智能体'}: ${(m.text || '(无文本)').slice(0, 300)}`);
      return { content: [{ type: 'text',
        text: clipMarked(`会话 ${sid} 最近 ${messages.length} 条消息:\n\n${lines.join('\n\n---\n\n')}`,
          CONFIG.intelDigestChars, '可减小 last 参数') }] };
    },
  };

  return [submitTaskReport, queryIntel, readSession];
}

/**
 * @param {object} record  session record (holds activeEngagement)
 * @param {object} caps    { dispatch, signalEngagement, emitBus }
 */
/**
 * Shared spawn_agent tool — registered in BOTH the orchestrator and the
 * child tool sets (identical definition; extracted to prevent drift).
 * [side-effects: spawns agent] [idempotent: no]
 */
function buildSpawnAgentTool(record, caps) {
  return {
    name: 'spawn_agent',
    label: '派生子智能体',
    description:
      'Spawn a sub-agent under YOU in the dispatch tree. Any stage agent or ' +
      'a sub-orchestrator (agentKey "autopwn" gets full scheduling powers ' +
      'and works for you). The spawned agent runs the instruction and ' +
      'reports back to you via [DM] when finished. Depth and total-agent ' +
      'limits are enforced; explain failures to the user if blocked. ' +
      '[side-effects: spawns agent]',
    executionMode: 'sequential',
    parameters: Type.Object({
      agentKey: Type.Union([
        stageEnum,
        Type.Literal('autopwn'),
      ], {
        description: 'Agent to spawn; "autopwn" = sub-orchestrator',
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

export function buildOrchestratorTools(record, caps) {
  const dispatchAgents = {
    name: 'dispatch_agents',
    label: '调度子智能体',
    description:
      '[side-effects: starts engagement] Dispatch a pentest objective to stage agents. They run in parallel ' +
      'inside a durable Temporal engagement and share findings over the bus.',
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
            `${started.agents.join(', ')} running. Findings will be ` +
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
      '[side-effects: sends DM] Relay a message to specific stage agents of your active engagement ' +
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
        throw new Error('no active engagement; dispatch_agents first');
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
      } catch (err) {
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
 * @param {object} record  engagement child session record
 * @param {object} caps    { signalEngagement, emitBus, followUp }
 */
export function buildChildTools(record, caps) {
  const publishFinding = {
    name: 'publish_finding',
    label: '发布发现',
    description:
      '[creates event] Publish a FINDING to the project intel base — visible to EVERY ' +
      'agent (query_intel) and the FINDINGS panel; the orchestrator is ' +
      'notified by DM. Use whenever a concrete discovery exists at any ' +
      'point mid-task. Always set severity and title; put description, ' +
      'evidence, and reproduction steps / PoC in text (markdown). ' +
      'You cannot message peer agents directly.',
    parameters: Type.Object({
      title: Type.String({
        description: 'One-line finding title, e.g. "Grafana default credentials"',
      }),
      severity: Type.Union([
        Type.Literal('info'), Type.Literal('low'), Type.Literal('medium'),
        Type.Literal('high'), Type.Literal('critical'),
      ], {
        description: 'Finding severity: info/low/medium/high/critical',
      }),
      text: Type.String({
        description:
          'Full finding content (markdown): description, evidence, ' +
          'reproduction steps / PoC, affected assets.',
      }),
    }),
    execute: async (_id, params) => {
      // Runtime-spawned children have no engagementId — null, never the
      // string 'autopwn-null' burned into provenance.
      const engagement = record.engagementId ? `autopwn-${record.engagementId}` : null;
      caps.emitBus({
        channel: 'dm', from: record.agentKey, to: 'orchestrator',
        type: 'intel',
        severity: params.severity,
        title: params.title,
        summary: params.title,
        detail: params.text,
        origin: 'engagement',
        author: caps.authorOf?.(record) ?? null,
        workSessionId: record.workSessionId ?? null,
        engagement,
      });
      // Fix-I (P12): remember titles so the completion DM can REFERENCE
      // findings instead of repeating them (auto-DM already carried the
      // full text). In-memory only: losing it on restart degrades to the
      // old verbose DM — cosmetic. Capped to keep DMs bounded.
      record.publishedFindingTitles = [...(record.publishedFindingTitles ?? []),
        params.title].slice(-5);
      // Spawned sub-orchestrators carry no orchestratorSessionId (their
      // overlord is the SPAWNER) — fall back to parentSessionId so the
      // DM never targets null and 404s after the bus emit.
      const dmTarget = record.orchestratorSessionId ?? record.parentSessionId;
      if (dmTarget) {
        await caps.followUp(
          dmTarget,
          `[DM from ${record.agentKey}] [${params.severity}] ${params.title}\n` +
          `${params.text}\n` +
          '(如其他智能体需要知情,用 relay_to_agents 转发;否则继续等待产出)',
        );
      }
      // Durable record in the workflow history (passive handler).
      // Best-effort: a completed engagement no longer accepts signals —
      // bus + followUp delivery already succeeded at that point.
      if (engagement) {
        try {
          await caps.signalEngagement(engagement, 'agentMessage', {
            from: record.agentKey,
            severity: params.severity,
            title: params.title,
            text: params.text,
          });
        } catch {
          // engagement already closed — skip the history entry
        }
      }
      return {
        content: [{
          type: 'text',
          text: `FINDING published (${String(params.severity).toLowerCase()}): ${params.title}`,
        }],
      };
    },
  };

  const spawnAgent = buildSpawnAgentTool(record, caps);

  // Deprecated alias: old transcripts may still carry this tool name.
  // Same handler; description steers to the canonical name. Remove after
  // one version of clean transcripts (MCP filesystem read_file precedent).
  const reportAlias = {
    ...publishFinding,
    name: 'report_to_orchestrator',
    label: '上报主控(废弃)',
    description: 'DEPRECATED: Use publish_finding instead. ' + publishFinding.description,
  };

  return [publishFinding, reportAlias, spawnAgent];
}

/**
 * @param {object} record  direct (non-engagement) user session record
 * @param {object} caps    { emitBus }
 */
export function buildDirectTools(record, caps) {
  const publishFinding = {
    name: 'publish_finding',
    label: '发布发现',
    description:
      '[creates event] Record a FINDING from this conversation into the ' +
      'FINDINGS panel (visible to every agent via query_intel). Call ' +
      'once per distinct finding — do not re-publish the same finding. ' +
      'You may still submit task reports separately; this tool only ' +
      'records findings. Use when the user asks or when a significant ' +
      'conclusion worth tracking emerges.',
    executionMode: 'sequential',
    parameters: Type.Object({
      title: Type.String({ description: 'One-line finding title' }),
      severity: Type.Union([
        Type.Literal('info'), Type.Literal('low'), Type.Literal('medium'),
        Type.Literal('high'), Type.Literal('critical'),
      ], { description: 'Finding severity: info/low/medium/high/critical' }),
      text: Type.String({
        description: 'Full content (markdown): description, evidence, PoC.',
      }),
    }),
    execute: async (_id, params) => {
      caps.emitBus({
        channel: 'dm', from: record.agentKey, to: 'user',
        type: 'intel',
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
          text: `FINDING published (${String(params.severity).toLowerCase()}): ${params.title}`,
        }],
      };
    },
  };

  return [publishFinding];
}
