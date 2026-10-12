/**
 * Write-ahead log for durable runtime state (sessions + bus).
 *
 * Durability contract: every entry is fsync'd to disk BEFORE the in-memory
 * write is acknowledged — a power cut loses at most the in-flight LLM run,
 * never the transcript. A crash mid-write can only tear the LAST line; the
 * reader stops there (all earlier lines were fsync'd complete).
 *
 * Compaction: on boot (after replay) and graceful shutdown the log is
 * rewritten atomically (tmp file + rename) from current in-memory state,
 * bounding growth while preserving the durability contract.
 */
import fs from 'node:fs';
import path from 'node:path';

export class Wal {
  /** 2026-10-10 事故补丁: 当前 WAL 里的会话条目数(compact 对账用)。 */
  countSessions() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      const ids = new Set();
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const e = JSON.parse(l);
          if ((e.t === 'session' || e.t === 'sess' || e.t === 'msg-batch') && e.d?.id) ids.add(e.d.id);
        } catch { /* 跳过坏行 */ }
      }
      return ids.size || null;
    } catch { return null; }
  }

  /** @param {string} file absolute WAL path; parent dirs are created */
  constructor(file) {
    this.file = file;
    this.fd = null;
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let fd;
    try {
      fd = fs.openSync(this.file, 'a');
    } catch (e) {
      // F5(部署审计四轮): 非根用户对默认 /var/lib/spectre 的 EACCES 此前
      // 裸栈崩溃——给出一行指引。
      if (e.code === 'EACCES' || e.code === 'ENOENT') {
        throw new Error(
          `无法打开 WAL ${this.file}(${e.code})——设置 SPECTRE_DATA_DIR 指向可写目录后重启, 例如 SPECTRE_DATA_DIR=/tmp/spectre-data`);
      }
      throw e;
    }
    this.fd = fd;
  }

  /** Durable append: fsync completes before this returns. */
  append(entry) {
    if (this.fd === null) {
      throw new Error('wal not open');
    }
    fs.writeSync(this.fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(this.fd);
  }

  /**
   * Read every durable entry. A torn (partial) final line from a crash
   * mid-write is dropped; a corrupt line in the MIDDLE is fatal — the
   * prefix guarantee makes that impossible without disk corruption.
   * @returns {{entries: object[], truncated: boolean}}
   */
  readAll() {
    if (!fs.existsSync(this.file)) {
      return { entries: [], truncated: false };
    }
    const raw = fs.readFileSync(this.file, 'utf8');
    const lines = raw.split('\n');
    const entries = [];
    let truncated = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        if (i === lines.length - 1) {
          truncated = true;  // torn tail from a crash mid-write
        } else {
          throw new Error(`wal corrupt at line ${i + 1}: ${line.slice(0, 80)}`);
        }
      }
    }
    return { entries, truncated };
  }

  /**
   * 2026-10-10 重设计(墓碑语义, 替代"内存快照全量重写"):
   * - WAL 自身是唯一真相源; compact 只做两种删除:
   *   ①tombstoned 项目 id 集合相关的记录(proj/sess/bus)
   *   ②尾部撕裂行(readAll 已标 truncated 的)
   * - 除此之外一条不动——内存里有什么/缺什么与存储永不相干
   * - 执行前 rotate 留三代(.wal.1/.wal.2/.wal.3), 任何覆盖都有前代兜底
   * - 对账: 保留条数 < (总条数 - 墓碑相关) 时拒绝执行(防墓碑误传全量)
   * @param {Set<string>} tombstonedProjIds 已删除项目 id 集合
   */
  compact(tombstonedProjIds = new Set()) {
    const { entries, truncated } = this.readAll();
    const tombs = tombstonedProjIds instanceof Set ? tombstonedProjIds : new Set(tombstonedProjIds);
    // 2026-10-11: 会话墓碑(内联收集)——sess-del 命中的 sess/msg/meta 物理清除
    const sessTombs = new Set(entries.filter(e => e?.t === 'sess-del').map(e => e?.d?.id));
    const kept = []; let dropped = 0;
    for (const e of entries) {
      const pid = e?.d?.id ?? e?.d?.projectId ?? e?.d?.workSessionId;
      const isProjRec = e?.t === 'proj' && tombs.has(e?.d?.id);
      const isSessOfTomb = e?.t === 'sess' && (tombs.has(pid) || sessTombs.has(pid));
      const isBusOfTomb = e?.t === 'bus' && tombs.has(e?.d?.workSessionId);
      const isMsgOfSessTomb = (e?.t === 'msg' || e?.t === 'meta') && sessTombs.has(e?.d?.sid);
      const isSessDelMarker = e?.t === 'sess-del';
      if (isProjRec || isSessOfTomb || isBusOfTomb || isMsgOfSessTomb || isSessDelMarker) { dropped++; continue; }
      kept.push(e);
    }
    // 对账: 剔除数必须≤墓碑可能关联数(宽松上界=每墓碑 × 条目总数过大也拦不住,
    // 用比例: 剔除超过总数 50% 且墓碑数 < 条目数×0.5 → 异常, 拒绝)
    if (dropped > entries.length * 0.5 && tombs.size < entries.length * 0.5) {
      throw new Error(`wal compact 对账失败: 拟删 ${dropped}/${entries.length} 条但墓碑仅 ${tombs.size} 个——拒绝执行(疑似误传)`);
    }
    // rotate 三代
    for (let g = 3; g >= 1; g--) {
      const from = g === 1 ? this.file : `${this.file}.${g - 1}`;
      const to = `${this.file}.${g}`;
      try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch { /* 尽力而为 */ }
    }
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    for (const entry of kept) {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    if (this.fd !== null) fs.closeSync(this.fd);
    fs.renameSync(tmp, this.file);
    const dirFd = fs.openSync(path.dirname(this.file), 'r');
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
    this.fd = fs.openSync(this.file, 'a');
    return { kept: kept.length, dropped, truncated };
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
