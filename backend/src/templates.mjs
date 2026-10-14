/**
 * 战役剧本(dispatch templates)——成功战役的派发参数存为可复用模板。
 *
 * 存储: WAL 载体 t:'tpl' {name, instruction, agents, sharedContext},
 * boot 回放(templatesFromWal); 内存 Map 为运行时唯一真身。模板是**跨
 * 项目**资产("泛微专项"不隶属某校)——与项目 prefs(projects.mjs)分离。
 * 消费面: dispatch_agents 的 template/saveAsTemplate 参数(tools.mjs),
 * 不设 HTTP CRUD——管理经编排器对话即工具面完成。
 */
import { Wal } from './persist.mjs';

/** name → { instruction, agents, sharedContext?, ts } */
const templates = new Map();

/** Boot replay: 从 WAL 条目恢复全部模板(后写覆盖同名)。 */
export function templatesFromWal(entries) {
  for (const e of entries) {
    if (e?.t === 'tpl' && e.d?.name) {
      templates.set(e.d.name, e.d.payload ?? e.d);
    }
  }
  return templates.size;
}

export async function saveTemplate(wal, name, payload) {
  const clean = String(name ?? '').trim().slice(0, 64);
  if (!clean) return { ok: false, error: '模板名必填(≤64 字符)' };
  if (!clean) return { ok: false, error: '模板名必填(≤64 字符)' };
  // P3(对抗审查): 名超长被截断存储——返回实际存储名(name 字段), 调用方
  // 的回执教截断后的真名, 不再出现"教一个永远不存在的名"。
  const body = {
    instruction: String(payload.instruction ?? ''),
    agents: Array.isArray(payload.agents) ? [...payload.agents] : [],
    sharedContext: payload.sharedContext ?? undefined,
    ts: new Date().toISOString(),
  };
  if (!body.instruction || !body.agents.length) {
    return { ok: false, error: '模板须含 instruction 与 agents' };
  }
  templates.set(clean, body);
  let warn = '';
  try {
    wal?.append?.({ t: 'tpl', d: { name: clean, payload: body } });
  } catch (e) {
    // P3: 磁盘满降级必须可观测——内存真身已生效, 重启即丢须告知。
    warn = `(⚠ WAL 写失败: ${String(e?.message ?? e).slice(0, 60)}——本次保存重启后丢失)`;
    console.error('[templates] WAL append degraded:', e?.message ?? e);
  }
  return { ok: true, name: clean, ...(warn ? { warn } : {}) };
}

export async function getTemplate(name) {
  return templates.get(String(name ?? '').trim()) ?? null;
}

export async function listTemplates() {
  return [...templates.entries()].map(([name, p]) => ({ name, agents: p.agents }));
}
