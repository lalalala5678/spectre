#!/usr/bin/env python3
"""spectre-arl — 资产库持久化+变化监测(ARL 灯塔模式, P1 借鉴)
资产不是一次性扫描结果而是持续维护的数据库:
  scan:   扫描结果入库(host/port/service/fingerprint)
  diff:   对比两次扫描——新增资产/消失资产/指纹变化
  watch:  定期重扫+变化告警(新子域/新端口/新服务=新攻击面)
用法:
  spectre-arl scan --project mycorp --input scan-result.json
  spectre-arl diff --project mycorp
  spectre-arl watch --project mycorp --interval 3600
  spectre-arl assets --project mycorp [--type subdomain|port|service]
"""
import sys, os, json, sqlite3, time, argparse, hashlib
from pathlib import Path

def _data_root():
    """数据根(R32D36 双运行位唯一制式): 容器内 /opt/tools 是 bind 挂载
    (bootstrap 标记识别); 宿主侧 SPECTRE_DATA_DIR。返回 tools 目录。"""
    if os.path.exists('/opt/tools/bootstrap-sandbox.sh'):
        return '/opt/tools'
    return os.path.join(os.environ.get('SPECTRE_DATA_DIR', '/var/lib/spectre'), 'tools')

DB_PATH = os.path.join(_data_root(), 'c2/arl-assets.db')  # CS10-4

def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute('''CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        type TEXT NOT NULL,           -- subdomain/host/port/service/fingerprint/url
        value TEXT NOT NULL,          -- 子域名/IP/port服务/指纹
        meta TEXT DEFAULT '{}',       -- 详情(title/status_code/tech)
        first_seen TEXT,
        last_seen TEXT,
        UNIQUE(project, type, value)
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY,
        project TEXT, ts TEXT, total INTEGER, new INTEGER
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY,
        project TEXT, ts TEXT,
        kind TEXT,                    -- added/removed/changed
        type TEXT, value TEXT, detail TEXT
    )''')
    return conn

def now(): return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

def ingest(conn, project, items):
    """items: [{type, value, meta}]"""
    scan_ts = now()
    cur = conn.cursor()
    new_count = 0
    for item in items:
        try:
            cur.execute('INSERT INTO assets (project,type,value,meta,first_seen,last_seen) VALUES (?,?,?,?,?,?)',
                        (project, item['type'], item['value'],
                         json.dumps(item.get('meta', {}), ensure_ascii=False), scan_ts, scan_ts))
            new_count += 1
        except sqlite3.IntegrityError:
            cur.execute('UPDATE assets SET last_seen=?, meta=? WHERE project=? AND type=? AND value=?',
                        (scan_ts, json.dumps(item.get('meta', {}), ensure_ascii=False),
                         project, item['type'], item['value']))
    scan_id = cur.execute('INSERT INTO scans (project,ts,total,new) VALUES (?,?,?,?)',
                          (project, scan_ts, len(items), new_count)).lastrowid
    conn.commit()
    return {'scan_id': scan_id, 'total': len(items), 'new': new_count, 'ts': scan_ts}

def diff(conn, project):
    """对比最近两次扫描——基于 first_seen/last_seen"""
    cur = conn.cursor()
    cur.execute("SELECT ts FROM scans WHERE project=? ORDER BY ts DESC LIMIT 2", (project,))
    rows = cur.fetchall()
    if len(rows) < 2:
        return {'error': '需要至少两次扫描'}
    latest, prev = rows[0][0], rows[1][0]

    added = cur.execute('''SELECT type, value, meta FROM assets
        WHERE project=? AND first_seen=? AND first_seen > ?''', (project, latest, prev)).fetchall()
    # 消失=上次看到但这次没更新
    all_assets = cur.execute('SELECT type, value, last_seen, first_seen FROM assets WHERE project=?',
                             (project,)).fetchall()
    removed = [(t, v) for t, v, ls, fs in all_assets if ls <= prev and fs <= prev]  # F27 off-by-one: prev 在场(ls==prev)而 latest 未更新才消失

    changes = {'added': [{'type': t, 'value': v, 'meta': json.loads(m)} for t, v, m in added],
               'removed': [{'type': t, 'value': v} for t, v in removed],
               'between': f'{prev} → {latest}'}
    for a in added:
        cur.execute('INSERT INTO changes (project,ts,kind,type,value,detail) VALUES (?,?,?,?,?,?)',
                    (project, latest, 'added', a[0], a[1], ''))
    conn.commit()
    return changes

def list_assets(conn, project, type_filter=None):
    q = 'SELECT type, value, meta, first_seen, last_seen FROM assets WHERE project=?'
    args = [project]
    if type_filter:
        q += ' AND type=?'
        args.append(type_filter)
    return cur_exec(conn, q, args)

def cur_exec(conn, q, args):
    cur = conn.cursor()
    cur.execute(q, args)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]

def main():
    p = argparse.ArgumentParser(description='spectre-arl: 资产库+变化监测')
    p.add_argument('mode', choices=['scan', 'diff', 'watch', 'assets', 'changes'])
    p.add_argument('--project', required=True)
    p.add_argument('--input', help='扫描结果 JSON')
    p.add_argument('--type', help='资产类型过滤')
    p.add_argument('--interval', type=int, default=3600)
    args = p.parse_args()
    conn = get_db()

    if args.mode == 'scan':
        data = json.load(open(args.input))
        items = data if isinstance(data, list) else data.get('assets', [])
        r = ingest(conn, args.project, items)
        print(f"[✓] scan#{r['scan_id']}: {r['total']} assets ({r['new']} new)")

    elif args.mode == 'diff':
        d = diff(conn, args.project)
        if 'error' in d:
            print(d['error']); sys.exit(1)
        print(f"== {d['between']} ==")
        print(f"新增 {len(d['added'])}:")
        for a in d['added'][:20]:
            print(f"  + [{a['type']}] {a['value']}")
        print(f"消失 {len(d['removed'])}:")
        for a in d['removed'][:20]:
            print(f"  - [{a['type']}] {a['value']}")
        if d['added']:
            print("\n⚠ 新增资产=新攻击面,应触发扫描")

    elif args.mode == 'assets':
        for a in list_assets(conn, args.project, args.type):
            print(f"[{a['type']:>10}] {a['value']}  (first: {a['first_seen'][:10]})")

    elif args.mode == 'changes':
        for c in cur_exec(conn, 'SELECT ts, kind, type, value FROM changes WHERE project=? ORDER BY ts DESC LIMIT 50', [args.project]):
            print(f"{c['ts'][:19]} [{c['kind']:>7}] {c['type']}: {c['value']}")

    elif args.mode == 'watch':
        print(f'watch mode: 每 {args.interval}s 提醒重扫(需外部调度器触发 scan)')
        # 实际 watch 由 Temporal/cron 调 spectre-arl scan

if __name__ == '__main__':
    sys.exit(main() or 0)
