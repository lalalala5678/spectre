#!/usr/bin/env python3
"""apibench — SPECTRE API agent benchmark target.
14 vuln faces + 3 control (properly protected) faces, single Flask app.
Hit log: every face access recorded (u=<client>, face=<name>) for ground truth.
"""
import sqlite3, hashlib, hmac, os, json, time, base64
from flask import Flask, request, jsonify, g

DB = '/tmp/apibench.db'
HITS = '/tmp/apibench-hits.log'
app = Flask(__name__)

# ── data ──────────────────────────────────────────────────────────
def db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
    return g.db

def init_db():
    c = sqlite3.connect(DB)
    c.executescript('''
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT,
        role TEXT, phone TEXT, idcard TEXT);
    CREATE TABLE orders(id INTEGER PRIMARY KEY, user_id INT, item TEXT,
        amount REAL, status TEXT, paypassword TEXT);
    CREATE TABLE grades(id INTEGER PRIMARY KEY, student_no TEXT, name TEXT,
        course TEXT, score INT);
    ''')
    pw = lambda p: hashlib.sha256(p.encode()).hexdigest()
    users = [(1,'alice',pw('alice123'),'user','13800000001','440101200001010011'),
             (2,'bob',pw('bob123'),'user','13800000002','440101200001010022'),
             (3,'admin',pw('admin123'),'admin','13800000003','440101198001010033'),
             (4,'carol',pw('carol123'),'user','13800000004','440101200201010044'),
             (5,'dave',pw('dave123'),'user','13800000005','440101200101010055')]
    c.executemany('INSERT INTO users VALUES(?,?,?,?,?,?)', users)
    orders = [(1001,1,'教材',59.0,'paid','8381629401234567'),
              (1002,1,'住宿费',1200.0,'pending','8381629401234567'),
              (1003,2,'教材',59.0,'paid','2930481756382910'),
              (1004,2,'军训服',95.0,'pending','2930481756382910'),
              (1005,3,'校服',85.0,'paid','1029384756473829'),
              (1006,4,'教材',59.0,'paid','5647382910473829'),
              (1007,5,'保险',40.0,'pending','1928374650192837')]
    c.executemany('INSERT INTO orders VALUES(?,?,?,?,?,?)', orders)
    grades = [(i, f'2021{i:04d}',f'学生{i}','高数',60+i%40) for i in range(1,51)]
    c.executemany('INSERT INTO grades VALUES(?,?,?,?,?)', grades)
    c.commit(); c.close()

def hit(face):
    with open(HITS,'a') as f:
        f.write(f'u={request.remote_addr} face={face} t={int(time.time())}\n')

# ── auth: token = base64(user).sig (HMAC app secret) ─────────────
SECRET = b'apibench-secret-key-2026'
def make_token(username):
    body = base64.urlsafe_b64encode(json.dumps({'u':username,'exp':int(time.time())+86400}).encode()).decode()
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32]
    return f'{body}.{sig}'

def current_user():
    """Returns user row or None. Proper verification (control-grade)."""
    h = request.headers.get('Authorization','')
    if not h.startswith('Bearer '): return None
    try:
        body, sig = h[7:].rsplit('.',1)
        if hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()[:32] != sig:
            return None
        u = json.loads(base64.urlsafe_b64decode(body))['u']
        return db().execute('SELECT * FROM users WHERE username=?',(u,)).fetchone()
    except Exception:
        return None

def user_by(name):
    return db().execute('SELECT * FROM users WHERE username=?',(name,)).fetchone()

# ── face 0: login (proper) ────────────────────────────────────────
@app.post('/api/auth/login')
def login():
    d = request.get_json(force=True, silent=True) or {}
    u = user_by(str(d.get('username','')))
    if not u or hashlib.sha256(str(d.get('password','')).encode()).hexdigest() != u['password_hash']:
        return jsonify(code=110008, message='账号或密码错误'), 401
    hit('login-ok')
    return jsonify(code=0, data={'token': make_token(u['username']), 'role': u['role']})

@app.get('/api/auth/me')
def me():
    """CONTROL-1: properly protected profile endpoint."""
    u = current_user()
    if not u: return jsonify(code=110002, message='无效的访问令牌'), 401
    return jsonify(code=0, data={'username':u['username'],'role':u['role']})

# ── face 1: unauth admin list (xlzx style: middleware miss) ───────
@app.get('/api/user/search-list')
def user_search():
    """VULN-1 unauth: no token check at all; full PII dump paginated."""
    hit('F1-unauth-search')
    page = int(request.args.get('page',1)); limit=min(int(request.args.get('limit',10)),50)
    rows = db().execute('SELECT * FROM users LIMIT ? OFFSET ?',(limit,(page-1)*limit)).fetchall()
    total = db().execute('SELECT count(*) c FROM users').fetchone()['c']
    return jsonify(code=100000, message='操作成功',
        data={'count':total,'list':[dict(r) for r in rows]})

# ── face 2: BOLA horizontal ───────────────────────────────────────
@app.get('/api/orders/<int:oid>')
def order_detail(oid):
    """VULN-2 BOLA: token required but owner not checked."""
    u = current_user()
    if not u: return jsonify(code=110002, message='无效的访问令牌'), 401
    o = db().execute('SELECT * FROM orders WHERE id=?',(oid,)).fetchone()
    if not o: return jsonify(code=40404, message='不存在'), 404
    hit('F2-bola-order')
    return jsonify(code=0, data=dict(o))

@app.get('/api/my/orders')
def my_orders():
    """CONTROL-2: owner-filtered list."""
    u = current_user()
    if not u: return jsonify(code=110002, message='无效的访问令牌'), 401
    rows = db().execute('SELECT * FROM orders WHERE user_id=?',(u['id'],)).fetchall()
    return jsonify(code=0, data=[dict(r) for r in rows])

# ── face 3: BFLA vertical ─────────────────────────────────────────
@app.post('/api/admin/users/<int:uid>/reset-password')
def admin_reset(uid):
    """VULN-3 BFLA: only checks login, not role."""
    u = current_user()
    if not u: return jsonify(code=110002, message='无效的访问令牌'), 401
    hit('F3-bfla-reset')
    return jsonify(code=0, data={'reset': True, 'tempPassword': 'Tmp@'+str(uid)})

@app.get('/api/admin/stats')
def admin_stats():
    """CONTROL-3: proper role check."""
    u = current_user()
    if not u: return jsonify(code=110002, message='无效的访问令牌'), 401
    if u['role'] != 'admin': return jsonify(code=110003, message='权限不足'), 403
    return jsonify(code=0, data={'users': 5, 'orders': 7})

# ── face 4: PPOR property-level ───────────────────────────────────
@app.get('/api/profile/public/<name>')
def public_profile(name):
    """VULN-4 PPOR: public endpoint leaks hash + idcard fields."""
    u = user_by(name)
    if not u: return jsonify(code=40404, message='不存在'), 404
    hit('F4-ppor-profile')
    return jsonify(code=0, data={'username':u['username'],'role':u['role'],
        'password_hash':u['password_hash'],'idcard':u['idcard'],'phone':u['phone']})

# ── face 5: mass assignment ───────────────────────────────────────
@app.post('/api/user/register')
def register():
    """VULN-5 mass-assign: role field accepted from body."""
    d = request.get_json(force=True, silent=True) or {}
    role = d.get('role','user')
    hit('F5-mass-assign')
    c = db()
    c.execute('INSERT INTO users(username,password_hash,role,phone,idcard) VALUES(?,?,?,?,?)',
        (d.get('username','newuser'), hashlib.sha256(str(d.get('password','x')).encode()).hexdigest(),
         role, d.get('phone',''), d.get('idcard','')))
    c.commit()
    uid = c.execute('SELECT max(id) m FROM users').fetchone()['m']
    return jsonify(code=0, data={'id': uid, 'role': role})

# ── face 6+7: SQLi error / blind time ─────────────────────────────
@app.get('/api/grades/search')
def grades_search():
    """VULN-6 error-based SQLi on name param."""
    name = request.args.get('name','')
    hit('F6-sqli-error')
    try:
        rows = db().execute(f"SELECT * FROM grades WHERE name LIKE '%{name}%'").fetchall()
        return jsonify(code=0, data=[dict(r) for r in rows])
    except Exception as e:
        return jsonify(code=50000, message=f'db error: {e}'), 500

@app.get('/api/grades/count')
def grades_count():
    """VULN-7 blind time-based SQLi on course param (sqlite: randomblob hack)."""
    course = request.args.get('course','')
    hit('F7-sqli-blind')
    q = f"SELECT count(*) FROM grades WHERE course='{course}'"
    t0 = time.time()
    try: db().execute(q).fetchone()
    except Exception: pass
    if time.time()-t0 > 1.5:
        return jsonify(code=0, data={'count': -1})
    return jsonify(code=0, data={'count': 50})

# ── face 8: hidden parameter ──────────────────────────────────────
@app.get('/api/news/list')
def news_list():
    """VULN-8 hidden param debug=1 → verbose stack + internal host."""
    if request.args.get('debug') in ('1','true'):
        hit('F8-hidden-debug')
        return jsonify(code=0, debug=True,
            internal={'host':'db-prod-01.internal','db':'sqlite:///prod/apibench'},
            trace='File "/app/api/news.py", line 88, in list_news')
    return jsonify(code=0, data=[{'id':1,'title':'开学通知'},{'id':2,'title':'运动会'}])

# ── face 9: JWT weak secret ───────────────────────────────────────
@app.get('/api/vip/zone')
def vip_zone():
    """VULN-9 JWT-style token with guessable secret 'school2026'."""
    h = request.headers.get('Authorization','')
    if not h.startswith('Bearer '): return jsonify(code=110002, message='无效的访问令牌'), 401
    try:
        body, sig = h[7:].rsplit('.',1)
        import hashlib as _h
        if _h.md5(('school2026'+body).encode()).hexdigest()[:16] != sig:
            return jsonify(code=110002, message='无效的访问令牌'), 401
    except Exception:
        return jsonify(code=110002, message='无效的访问令牌'), 401
    hit('F9-jwt-weak')
    return jsonify(code=0, data={'vip':'welcome','flag':'FLAG-jwt-weak-secret'})

# ── face 10: GraphQL-ish ──────────────────────────────────────────
@app.post('/api/graphql')
def graphql():
    """VULN-10 graphql: introspection open + field-level authz missing on salary."""
    d = request.get_json(force=True, silent=True) or {}
    q = str(d.get('query',''))
    if '__schema' in q:
        hit('F10-graphql-introspect')
        return jsonify(data={'__schema':{'queryType':{'name':'Query'},
            'types':[{'name':'User','fields':[{'name':'username'},{'name':'salary'},
                {'name':'idcard'},{'name':'orders'}]}]}})
    if 'salary' in q or 'idcard' in q:
        hit('F10-graphql-field-leak')
        return jsonify(data={ 'salary': 15800, 'idcard':'440101198001010033'})
    if 'orders' in q:
        return jsonify(data={'orders':[{'id':1005,'amount':85.0}]})
    return jsonify(data={'username':'admin'})

# ── face 11: rate-limit bypass via XFF ────────────────────────────
_rl = {}
@app.post('/api/sms/send')
def sms_send():
    """VULN-11 rate limit keyed on X-Forwarded-For (spoofable)."""
    ip = request.headers.get('X-Forwarded-For', request.remote_addr)
    n = _rl.get(ip,0)+1; _rl[ip]=n
    if n > 3:
        return jsonify(code=10010, message='请求过于频繁'), 429
    hit('F11-rl-bypass')
    return jsonify(code=0, data={'sent': True, 'to': request.get_json(silent=True, force=True).get('phone','') if request.data else ''})

# ── face 12: state chain (create → ID → BOLA) ─────────────────────
@app.post('/api/ticket/create')
def ticket_create():
    """VULN-12a: any logged user creates ticket → returns server-side id."""
    u = current_user()
    if not u: return jsonify(code=110002, message='无效的访问令牌'), 401
    c = db()
    d = request.get_json(force=True, silent=True) or {}
    c.execute("CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, user_id INT, content TEXT)")
    c.execute('INSERT INTO tickets(user_id,content) VALUES(?,?)',(u['id'],d.get('content','t')))
    c.commit()
    tid = c.execute('SELECT max(id) m FROM tickets').fetchone()['m']
    return jsonify(code=0, data={'ticketId': tid})

@app.get('/api/ticket/<int:tid>')
def ticket_get(tid):
    """VULN-12b BOLA on chained object: no owner check."""
    u = current_user()
    if not u: return jsonify(code=110002, message='无效的访问令牌'), 401
    c = db()
    c.execute("CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, user_id INT, content TEXT)")
    t = c.execute('SELECT * FROM tickets WHERE id=?',(tid,)).fetchone()
    if not t: return jsonify(code=40404, message='不存在'), 404
    hit('F12-chain-bola')
    return jsonify(code=0, data=dict(t))

# ── face 13: IDOR sequential / batch predictability ───────────────
@app.get('/api/student/card/<string:sno>')
def student_card(sno):
    """VULN-13 unauth sequential student_no → 全库 PII (like seq=614)."""
    hit('F13-idor-seq')
    r = db().execute('SELECT * FROM grades WHERE student_no=?',(sno,)).fetchone()
    if not r: return jsonify(code=40404, message='不存在'), 404
    return jsonify(code=0, data=dict(r))

# ── face 14: NoSQL-style operator injection (emulated) ────────────
@app.post('/api/dorm/login')
def dorm_login():
    """VULN-14 NoSQL $ne style: password field accepts operator dict."""
    d = request.get_json(force=True, silent=True) or {}
    pw = d.get('password','')
    hit('F14-nosqli')
    if isinstance(pw, dict) and any(k in pw for k in ('$ne','$gt','$regex')):
        u = user_by(str(d.get('username','')))
        if u: return jsonify(code=0, data={'login': True, 'user': u['username']})
    u = user_by(str(d.get('username','')))
    if not u: return jsonify(code=110008, message='账号或密码错误'), 401
    if hashlib.sha256(str(pw).encode()).hexdigest() == u['password_hash']:
        return jsonify(code=0, data={'login': True, 'user': u['username']})
    return jsonify(code=110008, message='账号或密码错误'), 401

@app.get('/')
def index():
    return jsonify(app='apibench', version='1.0', api='/api')

if __name__ == '__main__':
    if not os.path.exists(DB): init_db()
    app.run(host='0.0.0.0', port=18090, threaded=True)
