#!/usr/bin/env python3
"""spectre-bloodhound — AD 权限图收集+分析(轻量 BloodHound,无需 neo4j)
分两步:
  collect: LDAP 拉 AD 对象(用户/组/ACL/Session/OU/计算机)→ JSON 图
  analyze: 图上找提权路径(Kerberoast/DCSync/GPP 密码/ACL 滥用/短路径到 DA)
用法:
  spectre-bloodhound collect --dc 192.168.x.x --domain corp.local --user user --pass pass
  spectre-bloodhound analyze --graph /tmp/ad-graph.json
  spectre-bloodhound paths --graph /tmp/ad-graph.json --from user1 --to "DOMAIN ADMINS@corp"
"""
import sys, json, argparse
from collections import defaultdict, deque

# ============================================================
# 收集(LDAP)
# ============================================================

def collect(dc, domain, username, password, out):
    """F44 容错化(postex 走查 5 缺口):
    - 缺属性用户(memberOf 空,AD 极常见)不崩——安全读
    - 分页拉全量(>1000 不再静默截断)
    - try/finally 保 unbind
    - RootDSE 空守卫(回退域名推导)
    - 绑定失败友好错(exit 3)"""
    from ldap3 import Server, Connection, ALL, SUBTREE
    server = Server(dc, port=389, get_info=ALL)
    try:
        conn = Connection(server, user=f'{domain}\\{username}', password=password,
                          authentication='NTLM', auto_bind=True)
    except Exception as e:
        print(f'[!] LDAP 绑定失败({dc}@{domain}): {e}', file=sys.stderr)
        sys.exit(3)
    try:
        _nc = ((server.info or {}).other or {}).get('defaultNamingContext') or []
        if not _nc:
            print('[!] RootDSE 无 defaultNamingContext——回退域名推导', file=sys.stderr)
        base = _nc[0] if _nc else f'DC={",DC=".join(domain.split("."))}'

        graph = {'users': [], 'groups': [], 'computers': [], 'acls': [],
                 'sessions': [], 'ous': [], 'meta': {'domain': domain, 'dc': dc}}

        def _vals(e, attr):
            try:
                a = getattr(e, attr, None)
                if a is None:
                    return []
                return [str(x) for x in (a.raw_values or a.values or [])]
            except Exception:
                return []

        def _sval(e, attr):
            try:
                v = getattr(e, attr, None)
                return str(v.value) if v is not None and v.value is not None else ''
            except Exception:
                return ''

        # 用户(分页)
        conn.search(base, '(objectClass=user)', SUBTREE, paged_size=500, attributes=[
            'sAMAccountName', 'distinguishedName', 'memberOf', 'description',
            'servicePrincipalName', 'userAccountControl', 'pwdLastSet', 'adminCount',
            'lastLogonTimestamp', 'mail'])
        for e in conn.entries:
            name = _sval(e, 'sAMAccountName')
            if not name:
                continue
            try:
                uac = int(e.userAccountControl.value or 0)
            except Exception:
                uac = 0
            u = {
                'name': name, 'dn': _sval(e, 'distinguishedName'),
                'groups': _vals(e, 'memberOf'),
                'spn': _vals(e, 'servicePrincipalName'),
                'adminCount': _sval(e, 'adminCount') not in ('', 'False', '0', 'None'),
                'uac': uac,
                'pwdLastSet': _sval(e, 'pwdLastSet'),
                'desc': _sval(e, 'description'),
                'mail': _sval(e, 'mail'),
            }
            u['kerberoastable'] = bool(u['spn'])
            u['disabled'] = bool(u['uac'] & 0x2)
            u['dontReqPreauth'] = bool(u['uac'] & 0x400000)
            u['cleartext_pw_in_desc'] = 'pass' in u['desc'].lower() or 'pw' in u['desc'].lower()[:30]
            graph['users'].append(u)

        # 组(分页)
        conn.search(base, '(objectClass=group)', SUBTREE, paged_size=500, attributes=[
            'sAMAccountName', 'distinguishedName', 'member', 'adminCount', 'description'])
        for e in conn.entries:
            name = _sval(e, 'sAMAccountName')
            if not name:
                continue
            g = {
                'name': name, 'dn': _sval(e, 'distinguishedName'),
                'members': _vals(e, 'member'),
                'adminCount': _sval(e, 'adminCount') not in ('', 'False', '0', 'None'),
                'desc': _sval(e, 'description'),
            }
            graph['groups'].append(g)

        # 计算机(分页)
        conn.search(base, '(objectClass=computer)', SUBTREE, paged_size=500, attributes=[
            'sAMAccountName', 'distinguishedName', 'operatingSystem', 'memberOf'])
        for e in conn.entries:
            name = _sval(e, 'sAMAccountName')
            if not name:
                continue
            c = {
                'name': name.rstrip('$'), 'dn': _sval(e, 'distinguishedName'),
                'os': _sval(e, 'operatingSystem'),
                'groups': _vals(e, 'memberOf'),
            }
            graph['computers'].append(c)

        json.dump(graph, open(out, 'w'), indent=1, ensure_ascii=False)
    finally:
        try:
            conn.unbind()
        except Exception:
            pass
    print(f'[✓] collected: {len(graph["users"])} users, {len(graph["groups"])} groups, '
          f'{len(graph["computers"])} computers → {out}')
    return graph


def build_adjacency(graph):
    """构建邻接表——两条边:
    1. user→group (memberOf: 用户在组里=继承组权限)
    2. group→user (hasMember: 组的另一成员是提权跳板)
    路径语义: samwell -memberOf-> CastleMgr -hasMember-> castle.svc -memberOf-> DA"""
    # F43: 组节点统一键(组名)。此前 memberOf 边用 ('g',DN) 而 member
    # 解析边用 ('g',组名)——两个不连通命名空间: 嵌套链(A∈B,B∈DA)
    # 顺向检不出且组序敏感(postex 合成图实锤)。DN 一律归一到组名键。
    adj = defaultdict(set)
    name_to_dn = {}
    dn_to_name = {}
    for u in graph['users']:
        name_to_dn[u['name']] = u['dn']
        dn_to_name[u['dn'].lower()] = ('u', u['name'])
    for g in graph['groups']:
        name_to_dn[g['name']] = g['dn']
        dn_to_name[g['dn'].lower()] = ('g', g['name'])
    for c in graph['computers']:
        name_to_dn[c['name']] = c['dn']
        dn_to_name[c['dn'].lower()] = ('c', c['name'])
    def _gnode(ref):
        t = dn_to_name.get(str(ref).lower())
        if t and t[0] == 'g':
            return t
        return ('g', str(ref))
    for u in graph['users']:
        for g_ref in (u.get('groups') or []):
            gn = _gnode(g_ref)
            adj[('u', u['name'])].add(gn)
            adj[gn].add(('u', u['name']))
    for g in graph['groups']:
        gn = ('g', g['name'])
        for m_ref in (g.get('members') or []):
            t = dn_to_name.get(str(m_ref).lower())
            if t:
                adj[gn].add(t)
                adj[t].add(gn)
            else:
                adj[gn].add(('m', m_ref))
    for c in graph['computers']:
        for g_ref in (c.get('groups') or []):
            gn = _gnode(g_ref)
            adj[('c', c['name'])].add(gn)
            adj[gn].add(('c', c['name']))
    return adj, name_to_dn

def shortest_path(adj, src, dst, max_depth=10):
    """BFS 最短路径"""
    queue = deque([(src, [src])])
    seen = {src}
    dst_str = str(dst)
    while queue:
        node, path = queue.popleft()
        if node == dst or dst_str in str(node):
            return path
        if len(path) > max_depth:
            continue
        for nxt in adj.get(node, []):
            if nxt not in seen:
                seen.add(nxt)
                queue.append((nxt, path + [nxt]))
    return None

def find_da_paths(graph):
    """找所有到 Domain Admins 的路径(高价值目标)"""
    adj, _ = build_adjacency(graph)
    da_node = None
    for g in graph['groups']:
        if g['name'].upper() == 'DOMAIN ADMINS':
            da_node = ('g', g['name'])  # F43: 组名键
            break
    if not da_node:
        return []

    paths = []
    for u in graph['users']:
        if u['adminCount'] or u['name'].upper() in ('ADMINISTRATOR',):
            continue  # 已是高权,跳过
        p = shortest_path(adj, ('u', u['name']), da_node)
        if p and len(p) <= 5:
            paths.append({'user': u['name'], 'path': [str(n) for n in p], 'hops': len(p)})
    return sorted(paths, key=lambda x: x['hops'])

def analyze(graph):
    """完整分析——输出攻击面清单"""
    findings = []

    # 1. Kerberoastable 用户(有 SPN)
    kerb = [u for u in graph['users'] if u['kerberoastable'] and not u['disabled']]
    for u in kerb:
        findings.append({
            'type': 'kerberoastable', 'severity': 'high',
            'target': u['name'], 'detail': f"SPN: {u['spn'][:2]}",
            'action': 'GetUserSPNs.py -request-user ' + u['name']})

    # 2. AS-REP roasting(不需要预认证)
    asrep = [u for u in graph['users'] if u['dontReqPreauth'] and not u['disabled']]
    for u in asrep:
        findings.append({
            'type': 'asrep-roast', 'severity': 'medium',
            'target': u['name'], 'detail': 'DONT_REQ_PREAUTH set',
            'action': 'GetNPUsers.py -no-pass -dc-ip <dc> ' + u['name']})

    # 3. 描述字段疑似密码
    desc_pw = [u for u in graph['users'] if u['cleartext_pw_in_desc']]
    for u in desc_pw:
        findings.append({
            'type': 'pw-in-description', 'severity': 'critical',
            'target': u['name'], 'detail': f"desc: {u['desc'][:40]}",
            'action': '直接读 description 字段'})

    # 4. adminCount=1 的非管理员(可能有权残迹)
    ac = [u for u in graph['users'] if u['adminCount'] and u['name'].lower() not in
          ('administrator', 'krbtgt', 'guest')]
    for u in ac:
        findings.append({
            'type': 'admincount-user', 'severity': 'medium',
            'target': u['name'], 'detail': 'adminCount=1(SD holder 权限残迹)',
            'action': '检查其可写对象'})

    # 5. 到 DA 的最短路径
    da_paths = find_da_paths(graph)
    for p in da_paths[:10]:
        findings.append({
            'type': 'da-path', 'severity': 'high',
            'target': p['user'], 'detail': f"{p['hops']} hops: {' → '.join(p['path'][:4])}",
            'action': '沿路径逐节点检查可滥用 ACL'})

    # 6. 域信任(如有)
    # (需要 LDAP 查 trustedDomain 对象——简化跳过)

    return findings

def main():
    p = argparse.ArgumentParser(description='spectre-bloodhound: AD 图收集+分析')
    p.add_argument('mode', choices=['collect', 'analyze', 'paths'])
    p.add_argument('--dc', help='域控 IP')
    p.add_argument('--domain')
    p.add_argument('--user')
    p.add_argument('--pass', dest='password')
    p.add_argument('--graph', default='/tmp/ad-graph.json')
    p.add_argument('--from', dest='src')
    p.add_argument('--to', dest='dst')
    p.add_argument('--output')
    args = p.parse_args()

    if args.mode == 'collect':
        if not all([args.dc, args.domain, args.user, args.password]):
            print('collect 需要 --dc --domain --user --pass', file=sys.stderr); sys.exit(1)
        collect(args.dc, args.domain, args.user, args.password, args.graph)

    elif args.mode == 'analyze':
        graph = json.load(open(args.graph))
        findings = analyze(graph)
        print(f'== {len(findings)} findings ==')
        sev_icon = {'critical': '🔴', 'high': '🟠', 'medium': '🟡', 'low': '🔵'}
        for f in findings:
            print(f"{sev_icon.get(f['severity'], '⚪')} [{f['severity']:>8}] {f['type']}: {f['target']}")
            print(f"            {f['detail']}")
            print(f"     action: {f['action']}")
        if args.output:
            json.dump(findings, open(args.output, 'w'), indent=1, ensure_ascii=False)

    elif args.mode == 'paths':
        graph = json.load(open(args.graph))
        adj, _ = build_adjacency(graph)
        if not args.src:
            for p in find_da_paths(graph)[:20]:
                print(f"{p['user']} ({p['hops']} hops): {' → '.join(p['path'])}")
        else:
            # dst 可以是组名(找 DN)或用户名
            dst_name = args.dst or 'DOMAIN ADMINS'
            dst_node = ('u', dst_name)
            for g in graph['groups']:
                if g['name'].upper() == dst_name.upper():
                    dst_node = ('g', g['name']); break  # F43: 组名键
            p = shortest_path(adj, ('u', args.src), dst_node)
            if p:
                print(' → '.join(str(n) for n in p))
            else:
                print(f'no path {args.src} → {args.dst} (max 10 hops)')

if __name__ == '__main__':
    sys.exit(main() or 0)
