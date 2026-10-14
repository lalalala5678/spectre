/**
 * Scope 资产实体——目标资产的攻击面档案(每 IP/域名一条)。
 *
 * 生产者: recon 席位(七阶段测绘的 P6 主机全貌/P4 拓扑/P5 CDN 落地面);
 * 消费者: 全部席位经 query_intel(kind=scope) 读取, nday/exploit 拿到
 * "什么端口部署了什么开源项目什么版本"直接开工。
 *
 * Upsert 语义: 同 target(规范化后) 的后续发布 = 修订(不建新条目,
 * revision chain 同漏洞/情报的 append-only 模型——原始保留, 现行版折叠)。
 * 规范化: 去协议前缀/去尾斜杠/去端口(端口在 ports 字段)/小写。
 */
import { emitRevision } from './revision.mjs';

/** target 规范化: https://Sub.Example.com:443/ → sub.example.com */
export function normalizeScopeTarget(raw) {
  let t = String(raw ?? '').trim().toLowerCase();
  t = t.replace(/^[a-z]+:\/\//, '');         // 剥协议
  t = t.replace(/\/.*$/, '');                 // 剥路径
  t = t.replace(/:\d{1,5}$/, '');             // 剥端口(端口在 ports 字段)
  t = t.replace(/^www\./, '');                // www 剥离(www.example.com ≡ example.com)
  return t || null;
}

/** Scope 条目形状校验+规范化: 返回 { ok, entry } 或 { ok:false, error } */
export function buildScopeEntry(params) {
  const target = normalizeScopeTarget(params.target ?? params.host ?? params.ip);
  if (!target || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(target)) {
    return { ok: false, error: 'target 必填(IP 或域名; 自动剥协议/路径/端口/www 前缀)' };
  }
  // ports: [{ port, service, version?, product? }] 或字符串 "80/http, 443/https/nginx 1.24"
  let ports = [];
  if (Array.isArray(params.ports)) {
    ports = params.ports.slice(0, 50).map(p => ({
      port: Number(p.port) || 0,
      service: String(p.service ?? p.protocol ?? '').slice(0, 40) || null,
      version: p.version ? String(p.version).slice(0, 100) : null,
      product: p.product ? String(p.product).slice(0, 100) : null,
    })).filter(p => p.port > 0 && p.port < 65536);
  } else if (typeof params.ports === 'string' && params.ports.trim()) {
    // 宽松字符串: "80/http, 443/https/nginx 1.24, 3306/mysql"
    ports = params.ports.split(/[,;]\s*/).slice(0, 50).map(seg => {
      const [port, service, ...rest] = seg.trim().split(/[:/]/);
      const p = Number(port);
      if (!p || p < 1 || p > 65535) return null;
      return { port: p, service: (service ?? '').slice(0, 40) || null,
        version: rest.join('/').slice(0, 100) || null, product: null };
    }).filter(Boolean);
  }
  // projects: [{ name, repo, version }] — 开源项目(GitHub 等)
  let projects = [];
  if (Array.isArray(params.projects)) {
    projects = params.projects.slice(0, 20).map(p => ({
      name: String(p.name ?? '').slice(0, 100) || null,
      repo: String(p.repo ?? p.source ?? '').slice(0, 200) || null,
      version: p.version ? String(p.version).slice(0, 60) : null,
    })).filter(p => p.name || p.repo);
  } else if (typeof params.projects === 'string' && params.projects.trim()) {
    projects = [{ name: params.projects.slice(0, 100), repo: null, version: null }];
  }
  const entry = {
    target,
    ports,
    os: params.os ? String(params.os).slice(0, 200) : null,
    projects,
    cdn: params.cdn ? String(params.cdn).slice(0, 60) : null,
    ip: params.ip ? String(params.ip).slice(0, 45) : null,
    title: params.title ? String(params.title).slice(0, 200) : null,
    notes: params.notes ? String(params.notes).slice(0, 2000) : null,
    tags: Array.isArray(params.tags) ? params.tags.slice(0, 8).map(String) : [],
  };
  return { ok: true, entry };
}

/**
 * publish_scope 的 emit 逻辑: 同 target 既有条目 → 修订(revision chain);
 * 无 → 新条目。detail 存结构化 JSON(前端 ScopePanel 直渲染)。
 */
export function emitScopeEntry(bus, callerRecord, params, authorOf) {
  const { ok, entry, error } = buildScopeEntry(params);
  if (!ok) return { ok: false, error };
  const ws = callerRecord.workSessionId ?? null;
  const existing = (bus.list?.() ?? bus.events ?? [])
    .filter(e => e.type === 'scope' && !e.revises
      && e.workSessionId === ws
      && normalizeScopeTarget(e.target) === entry.target)
    .sort((a, b) => (b.revision?.n ?? 0) - (a.revision?.n ?? 0))[0];
  const detail = JSON.stringify(entry, null, 2);
  const title = `${entry.target}${entry.projects?.[0]?.name ? ` · ${entry.projects[0].name}` : ''}`;
  if (existing) {
    const rev = emitRevision(bus, {
      target: existing,
      fields: { title, text: detail },
      reason: `资产档案更新(${callerRecord.agentKey})`,
      requestedBy: callerRecord.agentKey, approvedBy: callerRecord.agentKey,
    });
    return { ok: true, seq: existing.seq, revision: rev.revision.n, entry };
  }
  const ev = bus.emit({
    channel: 'share', from: callerRecord.agentKey, type: 'scope',
    author: authorOf?.(callerRecord) ?? null,
    target: entry.target,
    title, summary: title, detail,
    payloadRef: `sess:${callerRecord.id}`,
    workSessionId: ws,
  });
  return { ok: true, seq: ev?.seq ?? null, entry, revision: 0 };
}
