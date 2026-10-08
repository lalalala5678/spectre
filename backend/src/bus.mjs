/**
 * Message bus journal.
 *
 * Append-only record of inter-agent traffic (announce / dm / share) plus
 * SSE fan-out to console subscribers. Bus writes are internal-token only —
 * the console reads, Temporal activities write.
 */

import { CONFIG } from './config.mjs';
import { clipMarked } from './pi.mjs';

let seq = 0;
export class Bus {
  constructor(wal = null) {
    this.events = [];
    this.clients = new Set();
    this.wal = wal;
  }

  /** Replay persisted events (boot recovery); seq continues past the max.
   *  Truncated to the in-memory journal limit — WAL may hold more. */
  load(events) {
    const trimmed = events.length > CONFIG.busJournalLimit
      ? events.slice(-CONFIG.busJournalLimit) : events;
    this.events = trimmed;
    seq = trimmed.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  /**
   * @param {{channel: string, from: string, to?: string, type?: string,
   *          summary: string, payloadRef?: string|null,
   *          engagement?: string|null,
   *          severity?: string|null, title?: string|null,
   *          origin?: string|null, workSessionId?: string|null,
   *          status?: string|null, author?: string|null,
   *          revises?: number|null, void?: number|null,
   *          revision?: {n: number, reason?: string,
   *                       requestedBy?: string, approvedBy?: string}|null,
   *          requester?: string|null,
   *          detail?: string|null}} entry
   *
   * CS23-N10: origin/workSessionId/status/author 四字段此前 JSDoc 漏载
   * 而 emit 白名单实收——文档与白名单对齐。
   *
   * `severity`/`title`/`detail` carry structured vulnerability payloads:
   * the panel lists severity + title and expands the full detail.
   */
  emit(entry) {
    const event = {
      seq: ++seq,
      ts: new Date().toISOString(),
      channel: entry.channel,
      from: entry.from,
      to: entry.to || 'all',
      type: entry.type || 'context',
      // CS44-F2: 静默截断→单源打标(与 detail 的 clipMarked 同纪律; 此前
      // 裸切 500, query_intel 消费侧据已切文本谎报总数)。
      summary: String(entry.summary || '').slice(0, 500),
      summaryClipped: String(entry.summary || '').length > 500,
      payloadRef: entry.payloadRef ?? null,
      engagement: entry.engagement ?? null,
      severity: entry.severity ?? null,
      title: entry.title ?? null,
      origin: entry.origin ?? null,
      workSessionId: entry.workSessionId ?? null,
      status: entry.status ?? null,
      author: entry.author ?? null,
      // r47b: 授权请求流字段(此前白名单静默丢弃 target→去重失效, agent
      // 侧 15:36 每秒一条爆发实锤)。
      target: entry.target ?? null,
      reason: entry.reason ?? null,
      requester: entry.requester ?? null,
      resolves: entry.resolves ?? null,
      // revision chain (append-only: a revision is a NEW event pointing
      // at the original seq) + discoverer attribution on writer-published
      // vulnerabilities — previously silently dropped by this whitelist.
      revises: entry.revises ?? null,
      void: entry.void ?? null,
      revision: entry.revision ?? null,
      requester: entry.requester ?? null,
      detail: entry.detail ? clipMarked(entry.detail, CONFIG.busDetailMaxChars) : null,
    };
    // Idempotency for vulnerability/intel publications(CS67-4: 代码两
    // 分支, 注释此前只提 vulnerability): 同 title+severity 重复落账
    // (receipt 式重发)幂等 no-op。
    if ((entry.type === 'vulnerability' || entry.type === 'intel')
      && entry.title && entry.severity && !entry.revises) {
      // r15v2-①: 去重收紧为零误伤——v1 的归一前缀键(16/120 字符)在同
      // 靶场场景 5 例误吞不同漏洞+假成功回执(吞写比双账更危险, r15 实
      // 测撤回)。现仅三键全严: ①精确 title+severity(原逻辑) ②标题全串
      // 归一后完全相等(标点/大小写差异) ③同发现者 5 分钟内 detail 全串
      // 归一相等(重复提交)。跨 writer 相似标题不自动合并——由 writer
      // query_intel 纪律处置(平台已有惯例)。
      const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
      const normD = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const nearEv = (ev, ms) => Date.now() - Date.parse(ev.ts ?? 0) < ms;
      const dup = [...this.events].reverse().find(e =>
        (e.type === 'vulnerability' || e.type === 'intel')
        && e.workSessionId === entry.workSessionId && !e.revises
        && ((e.title === entry.title && e.severity === entry.severity)
          || (norm(e.title) !== '' && norm(e.title) === norm(entry.title) && e.severity === entry.severity)
          || (e.from === entry.from && nearEv(e, 5 * 60_000)
            && normD(e.detail) !== '' && normD(e.detail) === normD(entry.detail))));
      if (dup) {
        dup.coDiscoverers = [...new Set([...(dup.coDiscoverers ?? []), entry.author?.name ?? entry.from].filter(Boolean))];
        return dup;
      }
    }
    // r28-#4(b): 落账后提示性二次扫描(裁决三护栏: 建议从不吞并/每对
    // 仅一次/双 seq+正本明示)——跨 writer 并发双账的零误伤补偿面。
    if (event.type === 'vulnerability' && !entry.revises) {
      const mySeq = event.seq;
      setTimeout(() => this.suggestDupMerge(mySeq), 10_000).unref?.();
    }
    // Write-ahead: durable on disk before it exists in memory/SSE.
    this.wal?.append({ t: 'bus', d: event });
    this.events.push(event);
    if (this.events.length > CONFIG.busJournalLimit) {
      this.events.splice(0, this.events.length - CONFIG.busJournalLimit);
    }
    this._broadcast(event);
    return event;
  }

  /** r29-#2: 落账前互斥预检——短窗内同项目高重叠
   * vuln 存在则拦截(非吞并): 返回 {blocked, dupSeq} 由调用方回执指引
   * revise 并入。与 suggestDupMerge(事后提示)互补, 双保险。 */
  vulnMutexCheck(entry) {
    if (entry.type !== 'vulnerability' || entry.revises) return null;
    const tokens = t => new Set(String(t ?? '').toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5:/.]+/).filter(x => x.length > 2));
    const mt = tokens(`${entry.title} ${entry.detail ?? ''}`);
    if (mt.size < 4) return null;
    // r29f-终判: 窗 120s→10min——writer 同步等待实测 tRw≈131s,
    // 120s 窗 < writer 耗时, 窗边界洞靠事后安全网兜(4954/4956 实证)。
    // 10min 与 suggestDupMerge 事后提示窗对齐, 双网同界。
    const cut = Date.now() - 600_000;
    // r43-②: 指纹永久窗——同端点双报实测差 43min(6172→6197), 10min
    // 互斥窗全程未参与, 双正本靠 writer 纪律手动归并兜底。指纹命中不
    // 限时窗(同端点同项目终身一正本); token 重叠保持短窗。
    const fpCut = Date.now() - 365 * 24 * 3600e3;
    for (const other of this.events) {
      // r29b-V3': severity 同等条件删除——紧竞态+定级分歧(high vs
      // medium)曾逃逸互斥双落账(4864/4866)。token 重叠≥70%+同项目+
      // 短窗已足够强; 定级分歧恰是同点位双账的常见形态, 应拦而引
      // revise 归并(定级由修订链裁决), 不该因等级不同放行双正本。
      const otherTs = Date.parse(other.ts ?? 0);
      // loop40-①: 作废条目退出互斥——已作废正本的端点指纹 6/6 确定性
      // 拦截新漏洞落账(CWE-338 writer 复核成立仍入不了账, 证据被错并
      // 进作废条目修订链)。作废=审计存档, 不再占用"同端点终身一正本"
      // 的指纹名额。
      // loop-DVGA复盘-B: 跨 ws 同靶场也比对——ws(None/项目1/项目2)曾
      // 使同一靶场同一漏洞落 3 条正本(9144/9169/9220)。同 ws 照旧全量
      // 比对; 跨 ws 时仅当双方 port 指纹有交集(同靶场实例)才进入
      // token/指纹比对(不同靶场跨项目放行不受影响)。
      const sameWs = other.workSessionId === entry.workSessionId;
      if (other.type !== 'vulnerability' || other.revises || other.void
        || otherTs < fpCut) continue;
      if (!sameWs) {
        // 靶场指纹源=title+detail(title 常无端口, DVGA 案例全在 detail)。
        // crAPI 循环1 复盘收紧: 裸 port 形态退出跨项目比对——chromaDB
        // (.3 无认证)曾被 port:8000 交集误配 7334《172.18.0.2:8000》
        // (IP 都不符, 9689 注记); 跨项目只认完整 host:port 串(同实例
        // 强特征), 端口号撞车是弱特征。
        const ep = x => new Set(String(x ?? '').toLowerCase()
          .match(/\b\d{1,3}(?:\.\d{1,3}){3}:\d{4,5}\b/g) ?? []);
        const aP = ep(`${entry.title} ${entry.detail ?? ''}`);
        const bP = ep(`${other.title} ${other.detail ?? ''}`);
        if (![...aP].some(pt => bP.has(pt))) continue;  // 无共同实例指纹: 放行
      }
      const ot = tokens(`${other.title} ${other.detail ?? ''}`);
      if (ot.size < 4) continue;
      let hit = 0;
      for (const t of ot) if (mt.has(t)) hit += 1;
      // r29f-A: 端点指纹 OR 条件——同点位独立撰写(detail 各自扩写,
      // token 重叠实测仅 0.36)曾穿透双正本(4920/4921)。同端点
      // (/path 指纹)短窗并发才是同点位竞态的本质特征; 阈值拦同文,
      // 指纹拦同点位, 二者其一即拦(零吞并, revise 归并保荣誉)。
      // loop22: 指纹扩展端口形态——TCP 服务洞(authd 18402)标题无 /path,
      // 措辞分歧双账曾穿透(5173/5177)。严格边界(两侧非 \w-)排除
      // CVE-2024 年份等连字数字, 归一为 port:NNNN。
      const paths = t => {
        const lo = String(t ?? '').toLowerCase();
        const out = new Set(lo.match(/\/[a-z0-9_.-]{2,}(?:\/[a-z0-9_.-]{2,})*/g) ?? []);
        for (const m of lo.matchAll(/(?<![\w-])(\d{4,5})(?![\w-])/g)) {
          out.add(`port:${m[1]}`);
        }
        return out;
      };
      // loop21-①: 指纹源收窄 title-only——弱口令洞正文连带提及 /api/user
      // (攻击链语境)曾被 BOLA 正本端点字面量误拦三次(5042/5043)。writer
      // 标题规范要求"资产+端点+漏洞类型", 同点位标题必含同端点; 正文
      // 提及异端点是攻击链常态, 不构成同点位证据。
      const mp = paths(entry.title);
      const op = paths(other.title);
      let phit = 0;
      for (const t of op) if (mp.has(t)) phit += 1;
      const overlap = hit / Math.min(ot.size, mt.size);
      // r47-D5: 跨资产铁判——双方都含 port: 指纹但无交集(8025 vs
      // 18370)必为不同资产实例, 路径撞(/api/v1/users)不得并(真洞三拦
      // 实证 6916/6917/6918)。path 单证仅在双方均无 port 指纹时成立。
      const myPorts = [...mp].filter(t => t.startsWith('port:'));
      const oPorts = [...op].filter(t => t.startsWith('port:'));
      const portsCompatible = myPorts.length === 0 || oPorts.length === 0
        || myPorts.some(pt => oPorts.includes(pt));
      // crAPI 循环1 复盘收紧: 纯 port: 指纹不构成同点位证据——同端口可载
      // 多洞(30080 上 BOLA/SQLi/JWT 各自正本), 且跨资产 port 撞车已实
      // 证。同点位指纹 = 真 path 串交集(非 port:) 或双方均无 path 时
      // host:port 串全等; 裸 port 只保留同 ws 的 portsCompatible 辅判。
      // 纯数字段(CWE-521/307、CVE-2024-1234 的编号尾巴)不是端点 path
      const realPaths = t => [...t].filter(x => !x.startsWith('port:') && /[a-z]/.test(x));
      // 无 path 形态(TCP 服务洞, 5173/5177 场景): port 集全等即同点位
      // ——同 ws 内同端口=同服务; 跨 ws 已被 R2a 完整串门槛先行挡住,
      // 此分支天然只在同 ws 生效。双方均无任何指纹时不构成证据。
      const realPathHit = (realPaths(mp).some(x => realPaths(op).includes(x)))
        || (realPaths(mp).length === 0 && realPaths(op).length === 0
          && myPorts.length > 0 && oPorts.length > 0
          && myPorts.length === oPorts.length
          && myPorts.every(pt => oPorts.includes(pt)));
      const fpMatch = realPathHit && mp.size > 0 && op.size > 0
        && phit / Math.min(op.size, mp.size) >= 0.5 && portsCompatible;
      // r43-②: token 高重叠仅短窗; 指纹命中不限窗
      // Q1(WebGoat循环2): token 重叠路径加端点约束——同 WebGoat/challenge
      // 语境词在 /challenge/7 vs /challenge/8(不同完整端点)全撞(C8 被误
      // 并 9973 修订8, 活锁至 17 修订实证)——行文相似但端点无交集=不同
      // 漏洞, 放行; 端点交集交由 fpMatch 精判。
      const mpNow = paths(entry.title);
      const opNow = paths(other.title);
      const rpMine = [...mpNow].filter(x => !x.startsWith('port:'));
      const rpOther = [...opNow].filter(x => !x.startsWith('port:'));
      const endpointCompatible = rpMine.length === 0 || rpOther.length === 0
        || rpMine.some(x => rpOther.includes(x));
      if (((overlap >= 0.7 && endpointCompatible) && otherTs >= cut) || fpMatch) {
        return { blocked: true, dupSeq: other.seq, dupTitle: other.title,
          dupWs: other.workSessionId ?? null,
          ...(fpMatch ? { by: 'fingerprint' } : {}) };
      }
    }
    return null;
  }

  /** r28-#4(b): 同点位双账建议——token 重叠>70% 且端点快检命中才提示,
   * 每对仅一次(查已有建议覆盖), 从不吞并(修订链由 writer 裁决)。 */
  suggestDupMerge(seq) {
    const me = this.events.find(e => e.seq === seq);
    if (!me || me.revises) return;
    const tokens = t => new Set(String(t ?? '').toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fa5:/.]+/).filter(x => x.length > 2));
    const mt = tokens(`${me.title} ${me.detail ?? ''}`);
    if (mt.size < 4) return;
    const cut = Date.now() - 10 * 60_000;
    for (const other of this.events) {
      if (other.seq === seq || other.type !== 'vulnerability' || other.revises
        || other.workSessionId !== me.workSessionId
        || (other.severity ?? '') !== (me.severity ?? '')
        || Date.parse(other.ts ?? 0) < cut) continue;
      const ot = tokens(`${other.title} ${other.detail ?? ''}`);
      let hit = 0;
      for (const t of ot) if (mt.has(t)) hit += 1;
      if (ot.size < 4 || hit / Math.min(ot.size, mt.size) < 0.7) continue;
      const pair = [seq, other.seq].sort((a, b) => a - b).join('+');
      const already = this.events.some(e => e.type === 'intel-note'
        && String(e.detail ?? '').includes(`重复对 ${pair}`));
      if (already) return;
      const primary = pair.split('+')[0];
      // 事件构造走与 emit 同一工厂(seq 自增)——_nextEvent 不存在时内联
      const dupEv = {
        channel: 'audit', from: 'system', type: 'intel-note',
        title: `疑似同点位双账建议(重复对 ${pair})`,
        summary: `漏洞 seq=${seq} 与 seq=${other.seq} 疑似同点位(token 重叠>70%)——建议经修订链合并, 正本=${primary}`,
        detail: `r28-#4(b) 提示性扫描: seq=${seq}/seq=${other.seq} 标题+正文 token 重叠超阈值。处理建议: 经 request_vulnerability_revision 将后到者并入先到者(正本=${primary}, 首落为正), 双发现者署名并入 coDiscoverers。本建议从不自动吞并(重复对 ${pair} 仅提示一次)。`,
        workSessionId: me.workSessionId ?? null,
      };
      dupEv.seq = ++seq; dupEv.ts = new Date().toISOString();
      this.events.push(dupEv);
      this._broadcast?.(dupEv);
      return;
    }
  }

  list(since = 0) {
    return this.events.filter(e => e.seq > since);
  }

  /** Replay past `since`, then attach the SSE client. */
  attach(stream, since = 0) {
    for (const event of this.list(since)) {
      stream.write(`event: bus\ndata: ${JSON.stringify(event)}\n\n`);
    }
    this.clients.add(stream);
    stream.on('close', () => this.clients.delete(stream));
  }

  _broadcast(event) {
    const frame = `event: bus\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      // R26-F4: 背压记账(sessions._broadcast 同款)
      if (client.write(frame)) {
        client.__congested = 0;
      } else if ((client.__congested = (client.__congested || 0) + 1) >= 500) {
        client.destroy();
      }
    }
  }
}
