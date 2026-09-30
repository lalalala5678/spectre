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

  /** Atomic rewrite from current state (boot compaction / graceful stop). */
  compact(entries) {
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    for (const entry of entries) {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    if (this.fd !== null) {
      fs.closeSync(this.fd);
    }
    fs.renameSync(tmp, this.file);
    // fsync the directory so the rename itself survives power loss.
    const dirFd = fs.openSync(path.dirname(this.file), 'r');
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
    this.fd = fs.openSync(this.file, 'a');
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
