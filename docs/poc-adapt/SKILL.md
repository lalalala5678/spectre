---
name: poc-adapt
description: 需要下载/理解/改造公开 POC 或自构造验证请求, 含变体构造与防护绕过(patch 差异分析、WAF 变形字典、编码栈)时使用
---

# P2 验证: POC 改造与自构造(无害优先)

## 0. 安全线(先读, 不可覆盖)

RCE 只 echo 标记/id/whoami;文件读取只读证明性文件;DB 只 SELECT;不 DoS;
拿到证明即停。破坏性验证单次≤1 秒且可自愈,否则以存在性证明替代。

## 1. 有 nuclei 模板(定向单点)

```bash
nuclei -t /opt/tools/fingerprints/plugins-0x727/<vendor>/<product>/CVE-*.yaml \
  -u https://<目标> -nc -silent -timeout 10
# 禁止 -tags cve 全库跑(那是扫描器干他);模板 matcher 读一遍理解它测什么
```
模板命中≠可利用(有的 matcher 只是特征检测),命中后按 CVE 类型升级验证。

## 2. 有公开 POC(GitHub)

```bash
git clone --depth 1 <poc-url> /tmp/poc && ls /tmp/poc
cat /tmp/poc/*.py | head -100   # 逐行理解:入口参数/目标格式/payload 位置/判定条件
```
改造清单:
- [ ] 目标 URL/端口/路径适配(POC 常写死 http://localhost:8080)
- [ ] payload 替换为无害标记(执行命令改 echo SPECTRE-VERIFY-$$)
- [ ] 判定条件确认(POC 怎么算成功:回显?DNS?文件?)
- [ ] 网络出口:回连类 POC 先 nc -lvp <port> 起监听
- [ ] 依赖:POC 的 pip 依赖装 /tmp 临时 venv,不污染共享层

## 3. 无 POC(patch-to-exploit 自构造, 变体能力核心)

```bash
# cvelistV5 references 找 patch commit:
jq -r '.containers.cna.references[] | select(.tags | index("patch")) | .url' /opt/tools/cvelistV5/cves/.../CVE-*.json
# patch diff 读法:删掉的判断=可绕过的检查;改动的正则=注入点;
# 新增的转义=原样未转义的地方就是 payload 位置
curl -sL "<commit>.diff" | head -200
```
构造验证请求:从 diff 推出触发路径+参数+格式,先发无害探测
(时间戳/报错特征/布尔差异),确认漏洞存在再谈利用。

## 4. 验证结果的四态记录

```
资产|CVE|验证手段(模板/POC改造/自构造)|回执摘要(状态码+关键响应片段)|结论
```
回执必须是原文片段——下游(report agent/人工复核)只认证据。

## 变体与绕过

### 1. 变体构造(POC 失效时: 补丁只堵了 POC, 没堵漏洞)

```bash
# 拿 patch diff, 问三个问题:
# ① 补丁堵的是输入点还是利用链?(堵输入点=漏洞真修了;堵利用链=可换链)
# ② POC 用的路径/参数/编码是不是补丁黑名单之一?(黑名单=换形态过)
# ③ 补丁遗漏的等价入口?(同一 sink 的其它路由/别名/大小写变体)
```
变体手法表:
- 路径变体:`/api/user` → `/api//user`、`/api/./user`、`/api;%2fuser`、`/API/USER`
- 参数变体:同名参数污染(`?a=1&a=payload`)、数组包裹(`a[]=payload`)、
  JSON 里的 `content-type` 切换(form↔json 双解析差)
- 编码栈:URL(%XX)→双重编码(%25XX)→unicode(\uXXXX)→HTML实体(&#xXX;)
  **可叠加**(url+unicode 双层是 WAF 单次解码的经典绕过)
- sink 等价:命令注入的 `;` → `|`、`&&`、`%0a`、反引号;SSTI 的
  {{}} → {%%}、${}、#set
- 版本边界:补丁 backport 不全时,低版本分支的同一 CVE 编号下行为不同

### 2. WAF/防护绕过(遇到拦截响应时)

先识别防护特征:412/403+固定页(瑞数/创宇盾/安全狗/雷池), JS challenge
(瑞数动态 token),响应头(`X-WAF`/`Set-Caret`)。变形字典逐试并**记录
每种形态的结果**(过/拦/变形检测)——这个记录本身就是交付物:

| 形态 | 结果 |
|---|---|
| 原始 payload | 拦(412 瑞数页) |
| URL 编码 | 拦 |
| unicode+URL 双层 | 过(200) ← 下游用这个形态 |
| 分块传输 | 拦 |
| 注释分割 `sel/**/ect` | 过 |

```bash
# 分块传输绕过(手工构造 chunked):
curl -X POST https://<目标>/ -H "Transfer-Encoding: chunked" \
  --data-binary $'5\r\npaylo\r\n3\r\nad1=\r\n0\r\n\r\n'
# 大小写+注释(SQL 类):SeLeCt → Se/**/Le/**/Ct
```

### 3. 纪律

- 变体是"同一 CVE 的不同表达",台账同一行内记录,不算新 CVE
- 每个变体一次请求验证,不批量轰;变形字典最多 8-10 种形态,逐个记录
- 绕不过就记"未确认+已试形态清单",这是合格交付,不是失败
