---
name: subdomain-sweep
description: 需要对已知根域做子域名枚举(P1→P2 衔接)时使用——被动双源强制、免key第三源、字典爆破、dnsgen 置换、双层泛解析过滤
---

# 子域名枚举(被动+爆破,100 分导向;波次计数强制披露)

**纪律:每波必须报告 命中数/纯新增数 两个计数。禁止跳过任何波次,
除非有当次实测回执证明该波零增益。**SCUT 教训:只跑 crt.sh 一波会漏
65% 的资产(subfinder 免 key 一项就多 411 名,爆破再加 42 名内部命名
资产 backup/db1/dataapi/ai——纯被动永远拿不到)。

## 第一波:被动双源(强制两路都跑,分别计数)

```bash
curl -s "https://crt.sh/?q=%25.<root>&output=json" --max-time 90 \
  | jq -r '.[].name_value' | tr 'A-Z' 'a-z' | sed 's/^\*\.//' | sort -u  # 记 N1
subfinder -d <root> -silent -timeout 60 | sort -u                         # 记 N2
sort -u crt.txt sf.txt > passive-union.txt                                 # 记 N3=并集
```

## 第 1.5 波:免 key 第三源(逐个 curl,失败如实记)

```bash
curl -s "https://rapiddns.io/subdomain/<root>?full=1" | grep -oE '[a-zA-Z0-9.-]+\.<root>' | sort -u
curl -s "https://otx.alienvault.com/api/v1/indicators/domain/<root>/passive_dns" \
  | jq -r '.passive_dns[].hostname' | sort -u
```

## 第二波:双层泛解析过滤 + 解析验证

**第一层(根域)**:随机前缀测根。
```bash
dig +short "rnd${RANDOM}x.<root>" A   # 有 A = 根泛解析,全部结果需剔该 IP
```
**第二层(逐父区)**——SCUT 实测踩坑:`*.webvpn.<root>` 这类 WebVPN 改写区
自身泛解析(随机前缀全解析到 WebVPN IP),置换/爆破结果会被整区污染:
```bash
# 对已发现的高产父区(如 webvpn/wvpn/泛域名入口)各测随机前缀
dig +short "zzz$RANDOM.webvpn.<root>" A   # 命中 = 该区为泛区,整区从资产表剔除并单独标注
```
判定规则:泛区不进资产表,但泛区本身是一条拓扑情报(WebVPN 改写能力)。

验证(串行低速):
```bash
while read d; do ip=$(dig +short "$d" A | grep -E '^[0-9.]+$' | head -1)
  [ -n "$ip" ] && echo "$d $ip"; done < passive-union.txt | sort -u
```

## 第三波:字典爆破(dnsx + 2 万字典,公共 DNS,不算打目标)

```bash
sed "s/$/.<root>/" /opt/tools/dicts/domain_2w.txt > /tmp/bf.txt
cat /tmp/bf.txt | dnsx -silent -r 223.5.5.5 -r 119.29.29.29 -r 182.254.118.118 \
  | sort -u > brute-hits.txt        # 记 N4;约 3 分钟
# 注意:本环境 dnsx 1.2.1 的 -l 文件模式挂死(EXIT 124),必须 stdin 管道模式
# (agent 实测隔离,证据 seq=309/310);dig 到 223.5.5.5 UDP 正常
comm -23 brute-hits.txt passive-union.txt > brute-new.txt   # 记 N5=纯新增
```
内部命名高价值词(backup/db/dataapi/api/admin/test/vpn/dns)命中的
优先标注给下游——这些是被动源永远没有的。

## 第四波:dnsgen 置换(仅被动+爆破明显未饱和时)

```bash
dnsgen  # /opt/tools/bin/dnsgen,已含 PYTHONPATH passive-union.txt \
  | grep -v -x -f passive-union.txt | sort -u > perm.txt   # 可能百万级
# 裁剪:只对二级部门域(如 jw./lib./mail.)的置换子集抽样验证,别全量
shuf -n 30000 perm.txt > perm-sample.txt
cat perm-sample.txt | dnsx -silent -r 223.5.5.5 | grep -vE '\.webvpn\.<root>$|\.wvpn\.<root>$' \
  | comm -23 - known-all.txt       # 记 N6/N7,泛区必须先剔
```

## 第五波:递归发现

对已发现的**二级部门域**(jw./lib./sce./mail. 等)逐个重跑第一波
crt.sh(`%25.<sub>`)——部门站常挂自己的证书;从页面 HTML 里 grep 域名引用。

## 产物(必须含波次计数表)

```
波次 | 命中 | 纯新增 | 备注(零增益要有实测回执)
crt.sh N1 | subfinder N2 | 并集 N3 | rapiddns/otx | 爆破 N4/N5 | 置换 N6/N7 | 递归
资产行:子域 | 解析IP | CNAME链 | 来源波次 | 泛区标记
```
