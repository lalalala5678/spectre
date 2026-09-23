---
name: variant-bypass
description: 需要做变体构造或防护绕过(P2 进阶:patch 差异分析、WAF 变形字典、编码栈)时使用
---

# 变体与绕过:patch 差异 → 变体 payload;WAF → 变形字典

## 1. 变体构造(POC 失效时:补丁只堵了 POC,没堵漏洞)

```bash
# 拿 patch diff,问三个问题:
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

## 2. WAF/防护绕过(遇到拦截响应时)

先识别防护特征:412/403+固定页(瑞数/创宇盾/安全狗/雷池),JS challenge
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

## 3. 纪律

- 变体是"同一 CVE 的不同表达",台账同一行内记录,不算新 CVE
- 每个变体一次请求验证,不批量轰;变形字典最多 8-10 种形态,逐个记录
- 绕不过就记"未确认+已试形态清单",这是合格交付,不是失败
