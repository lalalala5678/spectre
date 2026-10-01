#!/usr/bin/env python3
"""phish-send v2 — SMTP 钓鱼邮件发送器(企业级仿真)
v2 新增: DKIM 签名 / Message-ID 域名一致性 / Reply-To 同域 / 路径式追踪 URL /
         附件 Mimetype 修正 / 多部分文本降级(CS23-N6: '内容混淆'虚标删除——obfuscate_url 恒等空转从未接线)
用法:
  phish-send.py send --smtp host:port --user u --pass p \\
      --from "Display <a@b>" --to targets.txt --subject "..." \\
      --html template.html --track-url https://t.co \\
      [--dkim-key key.pem --dkim-selector s1 --dkim-domain example.co] \\
      [--attach file] [--rate 5/min]
"""
import sys, os, smtplib, time, json, hashlib, argparse, secrets
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from email.utils import formataddr, formatdate
from pathlib import Path
for _p in ('/opt/tools/py', '/opt/tools/py/dkim', '/opt/tools/py/semgrep', '/opt/tools/py/dirsearch'):
    if _p not in sys.path:
        sys.path.insert(0, _p)

def _data_root():
    """数据根(R32D36 双运行位唯一制式): 容器内 /opt/tools 是 bind 挂载
    (bootstrap 标记识别); 宿主侧 SPECTRE_DATA_DIR。返回 tools 目录。"""
    if os.path.exists('/opt/tools/bootstrap-sandbox.sh'):
        return '/opt/tools'
    env = os.environ.get('SPECTRE_DATA_DIR', '')
    if env:
        return os.path.join(env, 'tools')
    # R32D41-N1: 宿主位缺 env 时静默回退生产数据根——曾实测跨实例
    # 误写(audit 行进生产 audit.log/dkim 目录建到生产)。回退时打一行
    # stderr 警告(不阻断; 生产 systemd 单元本就设了该 env)。
    print('[warn] SPECTRE_DATA_DIR 未设置, 回退缺省数据根 /var/lib/spectre'
          '(如非本意请先设置 SPECTRE_DATA_DIR)', file=sys.stderr)
    return '/var/lib/spectre/tools'

try:
    PYTHONPATH = ['/opt/tools/py/dkim', '/opt/tools/py']
    for p in PYTHONPATH:
        if p not in sys.path:
            sys.path.insert(0, p)
    import dkim as dkim_lib
    HAS_DKIM = True
except ImportError:
    HAS_DKIM = False


def edusrc_gate(paths=()):
    """F48: EDUSRC 硬隔离(同 c2-qa 语义)——env 旗标/路径含 edusrc 即 exit 76"""
    ev = os.environ.get('SPECTRE_EDUSRC', '')
    ev_hit = ev.lower() in ('1', 'true', 'yes') or ('edusrc' in ev.lower())
    import sys as _s
    for m in ((ev_hit and 'EDUSRC-FLAG') or '', os.getcwd(), *(str(p) for p in paths)):
        if m and 'edusrc' in str(m).lower():
            print('EDUSRC-REJECT: 教育 SRC 工作区禁用钓鱼能力(工具层硬隔离)', file=_s.stderr)
            _s.exit(76)
def load_smtp_default():
    """设置面板验证通过的 SMTP 通道(仅验证过才落盘)"""
    # CS8-P2-4: 死候选删除——唯一写入方 keyfiles.mjs 只写 tools/phish。
    for p in (os.path.join(_data_root(), 'phish/smtp.json'),):
        try:
            cfg = json.load(open(p))
            if cfg.get('host'):
                return cfg
        except Exception:
            continue
    return {}

def load_scope():
    try:
        return json.load(open(os.path.join(_data_root(), 'c2/scope.json')))
    except:
        return None

def gate():
    edusrc_gate()
    """完整授权门(F10 修复): targets+时间窗,同 c2-qa.py 语义"""
    sc = load_scope()
    import time as _t
    try:
        now = _t.strftime('%Y-%m-%dT%H:%M:%SZ', _t.gmtime())
        ok = (sc and sc.get('targets') and
              sc['window']['start'] and sc['window']['end'] and
              sc['window']['start'] <= now <= sc['window']['end'])
    except Exception:
        ok = False
    if not ok:
        print('SCOPE-REJECT: empty targets or out of window', file=sys.stderr)
        sys.exit(75)
    return sc

# ============================================================
# 仿真度核心函数
# ============================================================

def forge_message_id(domain):
    """Message-ID 的域名与 From 完全一致(不一致 = 邮件网关红旗)"""
    rand = secrets.token_hex(16)
    return f'<{rand}.{int(time.time())}@{domain}>'

def path_style_uid(recipient):
    """路径式追踪 ID(不用 query 参数——网关对 ?uid= 敏感)
    V4: 无盐 md5 可由邮箱推导伪造(writer 复现伪造事件全落)——改
    HMAC-SHA256(共享密钥 数据根 c2/phish-uid.key(_data_root() 双运行位),与 phish-track 同源)。"""
    import hmac as _hmac, os as _os, secrets as _sec
    KP = os.path.join(_data_root(), 'c2/phish-uid.key')
    try:
        k = open(KP, 'rb').read()
        if len(k) < 32:
            raise ValueError
    except Exception:
        k = _sec.token_bytes(32)
        try:
            _os.makedirs(_os.path.dirname(KP), exist_ok=True)
            fd = _os.open(KP, _os.O_WRONLY | _os.O_CREAT | _os.O_TRUNC, 0o600)
            _os.write(fd, k); _os.close(fd)
        except OSError:
            pass
    return _hmac.new(k, recipient.encode(), hashlib.sha256).hexdigest()[:12]

def render(html, recipient, track_base):
    """渲染模板: 注入路径式追踪 + 混淆"""
    uid = path_style_uid(recipient)
    # 路径式追踪: https://t.co/r/<uid>/redirect (不是 ?uid=xxx)
    click_url = f'{track_base}/r/{uid}'
    open_url = f'{track_base}/o/{uid}.gif'
    html = html.replace('{{TRACK_CLICK}}', click_url)
    html = html.replace('{{TRACK_OPEN}}', open_url)
    html = html.replace('{{EMAIL}}', recipient)
    return html, uid

def build_email(from_display, from_addr, to_addr, subject, html_body,
                reply_to=None, domain=None, text_body=None, attachments=None):
    """构造完整邮件(头部一致性核心)"""
    # 提取 From 域名
    from_domain = from_addr.split('@')[1] if '@' in from_addr else domain or 'localhost'

    # 优化项(seq1914): 附件须挂 mixed 容器——alternative 语义是
    # 同内容多格式,附件混入属结构误用(部分客户端丢弃)
    attachments = attachments or []
    msg = MIMEMultipart('mixed') if attachments else MIMEMultipart('alternative')
    if attachments:
        _alt = MIMEMultipart('alternative')
        msg.attach(_alt)
        msg._alt_part = _alt  # 文本部分挂 mixed>alternative

    # === 头部一致性(关键) ===
    msg['Subject'] = subject
    msg['From'] = formataddr((from_display, from_addr))
    msg['To'] = to_addr
    msg['Date'] = formatdate(localtime=True)
    # Message-ID 域名 = From 域名(不是发送 MTA 的域名)
    msg['Message-ID'] = forge_message_id(from_domain)

    # Reply-To: 同域或干脆不设(Reply-To 不同域 = 红旗)
    if reply_to and '@' in reply_to:
        reply_domain = reply_to.split('@')[1]
        if reply_domain == from_domain:
            msg['Reply-To'] = reply_to
        else:
            # 不同域→不设(比设一个不同域的更安全)
            pass

    # 纯文本降级(无 HTML 支持的客户端)
    if text_body:
        msg.attach(MIMEText(text_body, 'plain', 'utf-8'))
    else:
        # 自动生成纯文本版本
        import re
        plain = re.sub(r'<[^>]+>', ' ', html_body)
        plain = re.sub(r'\s+', ' ', plain).strip()
        msg.attach(MIMEText(plain[:2000], 'plain', 'utf-8'))

    _target = getattr(msg, '_alt_part', msg)
    _target.attach(MIMEText(html_body, 'html', 'utf-8'))
    return msg, from_domain

def dkim_sign(msg_bytes, private_key_path, selector, domain):
    """DKIM 签名(标准 RFC 6376)"""
    if not HAS_DKIM:
        # R32D39-N2: 此前静默 None——邮件无签名发出而无任何提示(实测
        # 抓包缺 DKIM-Signature)。显式告警到 stderr。
        print('[warn] dkimpy 未安装(--dkim-key 被忽略, 邮件将无 DKIM 签名)'
              '——容器位已内置; 宿主位 pipx install dkimpy / pip --break-system-packages(PEP 668) 或挂 /opt/tools/py',
              file=sys.stderr)
        return None
    with open(private_key_path, 'rb') as f:
        key = f.read()
    sig = dkim_lib.sign(msg_bytes, selector.encode(), domain.encode(), key,
                        include_headers=[b'from', b'to', b'subject', b'date', b'message-id'])
    return sig.decode()

def _smtp_dialog_send(s, from_addr, to_addr, raw):
    """V5: 非 RFC 中继降级投递。本地 qa-smtp 对 DATA 回 250 而非 354,
    smtplib.data() 遇非 354 直接抛 SMTPDataError —— 正文永远发不出去。
    该中继逐行全盘 250 接受,故手工发正文即可(仅授权本地中继场景)。"""
    code, repl = s.docmd(f'MAIL FROM:<{from_addr}>')
    if code != 250:
        raise smtplib.SMTPResponseException(code, repl)
    code, repl = s.docmd(f'RCPT TO:<{to_addr}>')
    if code not in (250, 251):
        raise smtplib.SMTPResponseException(code, repl)
    code, repl = s.docmd('DATA')
    if code == 354:
        import re as _re
        q = _re.sub(br'(?m)^\.', b'..', raw)  # 点透明化
        s.send(q + b'\r\n.\r\n')
        return s.getreply()
    # 非 RFC:250=已接受,照样发正文,结尾以 . 终结
    import re as _re
    q = _re.sub(br'(?m)^\.', b'..', raw)
    s.send(q + b'\r\n.\r\n')
    # 该中继对“每一行”都回一条 250(包括正文每一行)。若不排空就关闭,
    # 客户端 socket 带未读数据 close → RST → 服务端 drain() 崩溃、邮件不落盘(实测)。
    # 注意 as_bytes() 默认 LF 行尾 —— 必须先 CRLF 规范化再计数。
    n_replies = q.count(b'\n') + 2  # 正文行 + '.' + 余量
    old_to = s.sock.gettimeout()
    s.sock.settimeout(2)
    for _ in range(n_replies):
        try:
            c, _ = s.getreply()
        except (smtplib.SMTPServerDisconnected, OSError):
            break
        if c == 221:
            break
    s.sock.settimeout(old_to)
    return (250, b'ok (non-rfc relay accepted)')

def send_with_dkim(smtp_cfg, from_addr, to_addr, subject, html_body,
                   from_display, reply_to=None, attachments=None,
                   dkim_key=None, dkim_selector='s1', dkim_domain=None,
                   text_body=None):
    """发送一封完整仿真的邮件"""
    msg, from_domain = build_email(from_display, from_addr, to_addr,
                                   subject, html_body, reply_to, dkim_domain,
                                   text_body, attachments)


    for fpath in (attachments or []):
        with open(fpath, 'rb') as f:
            att = MIMEApplication(f.read(), Name=Path(fpath).name)
        att['Content-Disposition'] = f'attachment; filename="{Path(fpath).name}"'
        msg.attach(att)

    # DKIM 签名
    if dkim_key and os.path.isfile(dkim_key):
        raw = msg.as_bytes()
        sig = dkim_sign(raw, dkim_key, dkim_selector or 's1', dkim_domain or from_domain)
        if sig:
            msg['DKIM-Signature'] = sig.split('DKIM-Signature: ')[1] if 'DKIM-Signature: ' in sig else sig

    with smtplib.SMTP(smtp_cfg['host'], smtp_cfg['port'], timeout=smtp_cfg.get('timeout', 30)) as s:
        if smtp_cfg.get('tls', True):
            try:
                s.starttls()
            except smtplib.SMTPNotSupportedError:
                # F36: V5 的自动降级曾把 AUTH PLAIN 凭据明文出网(exploit
                # 假中继抓包实锤)。降级现须显式同意: smtp.json
                # "allow_plaintext": true 或 CLI --allow-plaintext;
                # 无凭据场景维持告警降级(无泄露面)。
                has_creds = bool(smtp_cfg.get('user') or smtp_cfg.get('pass'))
                allowed = bool(smtp_cfg.get('allow_plaintext'))
                if has_creds and not allowed:
                    raise SystemExit(
                        '[refuse] 中继不支持 STARTTLS 且已配置凭据——明文降级会把 AUTH '
                        'PLAIN 凭据裸送线路。如确需(仅限本地授权靶)在 smtp.json 加 '
                        '"allow_plaintext": true 或 CLI 传 --allow-plaintext。')
                print('[warn] relay lacks STARTTLS, downgrade to plaintext'
                      + (' (no credentials)' if not has_creds else ' (explicitly allowed)'), file=sys.stderr)
        if smtp_cfg.get('user') and 'auth' in s.esmtp_features:
            # V5 修复: 无 AUTH 能力的中继跳过 login(此前必抛 SMTPNotSupportedError;
            # 且 main() 用 `args.user or dflt.user`,空串无法覆盖=无法禁用鉴权)
            s.login(smtp_cfg['user'], smtp_cfg['pass'])
        try:
            s.send_message(msg)
        except smtplib.SMTPDataError as e:
            if e.smtp_code == 250:
                # V5: DATA 阶段返回 250 的非 RFC 中继 —— smtplib 抛异常且正文未发,
                # 降级到手工对话投递(实测本地 qa-smtp 即此行为)
                print('[warn] relay replied 250 to DATA (non-RFC), fallback to dialog send',
                      file=sys.stderr)
                # CS27-10: 死 import _policy 已删(as_bytes 用 compat32 缺省;
                # 注: msg.as_bytes(policy=SMTP) 对 compat32 非ASCII头(中文主题/显示名)
                # fold 时报 UnicodeEncodeError —— 改用与 send_message 内部一致的
                # compat32 原始字节(8-bit UTF-8),再手工 CRLF 规范化(RFC 5321 线序)
                import re as _re2
                raw = _re2.sub(br'\r?\n', b'\r\n', msg.as_bytes())
                code, repl = _smtp_dialog_send(s, from_addr, to_addr, raw)
                if code not in (250, 251):
                    raise
            else:
                raise
    return True

def track_sent(db_path, uid):
    """R15-F5: 发送成功记 sent 事件——漏斗分母(此前分母=已互动 uid,
    打开率结构性 100%)。V6c 锁协议与 phish-track 同源; 失败不阻塞
    发送循环(分母缺失时聚合端回退互动分母)。"""
    import json, fcntl, time, os
    try:
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        with open(db_path + '.lock', 'w') as lf:
            fcntl.flock(lf, fcntl.LOCK_EX)
            try:
                db = {'events': []}
                try:
                    db = json.load(open(db_path))
                except Exception:
                    pass
                db.setdefault('events', []).append(
                    {'kind': 'sent', 'uid': uid,
                     'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                json.dump(db, open(db_path, 'w'), indent=1)
            finally:
                fcntl.flock(lf, fcntl.LOCK_UN)
    except Exception as e:
        print(f'  (track-sent 失败不阻塞: {e})')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['send', 'dryrun', 'genkey'])
    p.add_argument('--smtp', help='host:port')
    p.add_argument('--user', default='')
    p.add_argument('--pass', dest='password', default='')
    p.add_argument('--from', dest='from_addr', required=False, help='email@domain')
    p.add_argument('--from-name', dest='from_name', default='', help='Display Name')
    p.add_argument('--reply-to', default='')
    p.add_argument('--to', help='收件人文件或单地址')
    p.add_argument('--subject', required=False)
    p.add_argument('--html', help='HTML 模板')
    p.add_argument('--track-url', default='https://t.local')
    p.add_argument('--track-db', default=os.path.join(_data_root(), 'phish/track.json'),
                    help='发送事件落库(漏斗分母, R15-F5)')
    p.add_argument('--attach', action='append')
    p.add_argument('--rate', default='5/min')
    p.add_argument('--allow-plaintext', action='store_true', help='显式同意明文降级(仅限本地授权靶;凭据将明文出网)')
    p.add_argument('--dkim-key', help='DKIM 私钥路径(pem)')
    p.add_argument('--dkim-selector', default='s1')
    p.add_argument('--dkim-domain', help='DKIM 签名域(默认 From 域)')
    # genkey mode
    p.add_argument('--genkey-domain', help='genkey 模式:为该域生成 DKIM 密钥对')
    p.add_argument('--genkey-selector', default='s1')
    args = p.parse_args()

    # R32D38-NEW-1: --from 接受 "Display <a@b>" 全形式(docstring 示范
    # 的写法此前整串当裸地址——from_domain 带尾括号, Message-ID 双闭
    # 括号+DKIM 域污染, 静默损坏)。parseaddr 拆解, --from-name 优先。
    if getattr(args, 'from_addr', None):
        from email.utils import parseaddr
        _disp, _addr = parseaddr(args.from_addr)
        if _addr and _addr != args.from_addr:
            if not args.from_name:
                args.from_name = _disp
            args.from_addr = _addr
    # CS10-8: --reply-to 同款 parseaddr 对称("Name <a@b>" 此前整串
    # 裸切致 reply_domain 带括号≠from_domain, Reply-To 静默丢弃)
    if getattr(args, 'reply_to', None):
        from email.utils import parseaddr as _pa
        _rd, _ra = _pa(args.reply_to)
        if _ra:
            args.reply_to = _ra
    # NEW-2: send 模式必填前置(此前逐目标打 'NoneType is not iterable')
    if args.mode == 'send' and not getattr(args, 'from_addr', None):
        print('缺少 --from <email@domain>(可选 --from-name "Display")', file=sys.stderr)
        return 2
    # NEW-3: --html 文件存在性友好报错(此前裸 FileNotFoundError 栈)
    if getattr(args, 'html', None) and args.mode in ('send', 'dryrun') \
            and not os.path.isfile(args.html):
        print(f'--html 文件不存在: {args.html}', file=sys.stderr)
        return 2

    # DKIM 密钥生成模式
    if args.mode == 'genkey':
        # V1 修复: genkey 先过授权门(此前 return 先于 gate()=旁路);
        # 域名净化(此前 ../../ 直拼路径=root 任意覆写)
        import re as _re
        gate()
        # F36: selector 未校验+域允许 '..' 字面量 → 组合穿越(root 任意
        # 目录覆写 *.pem, exploit PoC)。双字段白名单+段级 '..' 拒绝。
        if not _re.fullmatch(r'[A-Za-z0-9.-]{1,253}', args.genkey_domain or '') \
                or '..' in (args.genkey_domain or '').split('.'):
            print('genkey-domain 非法(仅 [A-Za-z0-9.-] 且无 .. 段)', file=sys.stderr)
            sys.exit(2)
        if not _re.fullmatch(r'[A-Za-z0-9_-]{1,63}', args.genkey_selector or 's1'):
            print('genkey-selector 非法(仅 [A-Za-z0-9_-])', file=sys.stderr)
            sys.exit(2)
        if not args.genkey_domain:
            print('genkey 需要 --genkey-domain', file=sys.stderr); sys.exit(1)
        import subprocess
        d = os.path.join(_data_root(), f'c2/dkim/{args.genkey_domain}')
        os.makedirs(d, exist_ok=True)
        subprocess.run(['openssl', 'genrsa', '-out', f'{d}/{args.genkey_selector}.pem', '2048'],
                      capture_output=True)
        pub = subprocess.run(['openssl', 'rsa', '-in', f'{d}/{args.genkey_selector}.pem',
                              '-pubout'], capture_output=True, text=True).stdout
        # DNS TXT record
        dns_val = ''.join(pub.strip().split('\n')[1:-1])
        print(f'私钥: {d}/{args.genkey_selector}.pem')
        print(f'DNS TXT 记录:')
        print(f'  {args.genkey_selector}._domainkey.{args.genkey_domain}. IN TXT "v=DKIM1; k=rsa; p={dns_val}"')
        print(f'SPF 记录: {args.genkey_domain}. IN TXT "v=spf1 include:<你的发送IP> ~all"')
        return 0

    gate()

    dflt = load_smtp_default()
    smtp_str = args.smtp or f"{dflt.get('host', '')}:{dflt.get('port', 587)}"
    host, _, port = smtp_str.rpartition(':')
    smtp_cfg = {'host': host, 'port': int(port or 587),
                'user': args.user or dflt.get('user', ''),
                'pass': args.password or dflt.get('pass', ''),
                'tls': True, 'timeout': 30,
                'allow_plaintext': bool(getattr(args, 'allow_plaintext', False))
                    or bool(dflt.get('allow_plaintext'))}

    if os.path.isfile(args.to or ''):
        targets = [l.strip() for l in open(args.to) if l.strip() and '@' in l]
    elif args.to:
        targets = [args.to.strip()]
    else:
        targets = []

    html_tpl = open(args.html).read() if args.html else '<html><body>{{BODY}}</body></html>'

    num, _, unit = args.rate.partition('/')
    interval = 60 / int(num) if unit.startswith('min') else 1 / int(num)

    sent = 0; failed = 0
    for i, to_addr in enumerate(targets):
        html_body, uid = render(html_tpl, to_addr, args.track_url)
        if args.mode == 'dryrun':
            print(f'--- [{i+1}/{len(targets)}] {to_addr} (uid={uid}) ---')
            print(f'  Message-ID domain: {args.from_addr.split("@")[1] if "@" in args.from_addr else "?"}')
            # R32D40-NEW-2: dryrun 预检接 HAS_DKIM 实况——此前只看
            # 旗标, 无 dkimpy 时预检谎报 YES 而 send 才告警。
            if args.dkim_key and HAS_DKIM:
                print('  DKIM: YES')
            elif args.dkim_key:
                print('  DKIM: SKIP (dkimpy 未安装——send 时将告警且不签名; '
                      '容器位内置/宿主 pipx install dkimpy 或 pip install --break-system-packages dkimpy)')
            else:
                print('  DKIM: NO (will fail gateway)')
            print(f'  Tracking: {args.track_url}/r/{uid}')
            print(html_body[:400])
            continue
        try:
            send_with_dkim(smtp_cfg, args.from_addr, to_addr, args.subject,
                          html_body, args.from_name or '', args.reply_to,
                          args.attach, args.dkim_key, args.dkim_selector,
                          args.dkim_domain or (args.from_addr.split('@')[1] if '@' in args.from_addr else None))
            sent += 1
            track_sent(args.track_db, uid)  # R15-F5: sent 事件=漏斗分母
            print(f'[{i+1}/{len(targets)}] OK {to_addr} (uid={uid})')
        except Exception as e:
            failed += 1
            print(f'[{i+1}/{len(targets)}] FAIL {to_addr}: {e}')
        if i < len(targets) - 1:
            time.sleep(interval)

    print(f'\n{sent} sent / {failed} failed / {len(targets)} total')
    if args.mode == 'send':
        # V5 修复: dryrun 也写审计日志(实测写了 PHISH-V2 ... 0/1)=审计污染,
        # 只对真实发送落账
        with open(os.path.join(_data_root(), 'c2/audit.log'), 'a') as f:
            f.write(f'PHISH-V2\t{(args.subject or "")[:50]}\t{sent}/{len(targets)}\n')
    return 0 if failed == 0 else 1

if __name__ == '__main__':
    sys.exit(main())
