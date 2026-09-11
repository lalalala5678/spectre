---
name: poc-adapt
description: 需要下载/理解/改造公开 POC 或自构造验证请求(P2 核心:无害验证优先、payload 最小化)时使用
---

# P2 验证:POC 改造与自构造(无害优先)

## 0. 安全线(先读,不可覆盖)

RCE 只 echo 标记/id/whoami;文件读取只读证明性文件;DB 只 SELECT;不 DoS;
拿到证明即停。破坏性验证单次≤1 秒且可自愈,否则以存在性证明替代。

## 1. 有 nuclei 模板(定向单点)

```bash
nuclei -t /var/lib/spectre/tools/fingerprints/plugins-0x727/<vendor>/<product>/CVE-*.yaml \
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

## 3. 无 POC(patch-to-exploit 自构造,变体能力核心)

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
