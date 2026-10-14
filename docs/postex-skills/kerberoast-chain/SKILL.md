---
name: kerberoast-chain
description: Kerberoast/AS-REP 全链——SPN 请求→hashcat 离线破解→凭据复用面回灌
---

# Kerberoast 全链(postex/AD 深度)

[read-only 请求 + 离线破解] 两段式: 在线段只发 TGS 请求(域内正常行为,
单账户一次); 破解段全离线(沙箱内 hashcat, 不产生目标流量)。

## 第一段·hash 采集(在线, 轻)

1. Kerberoast: `GetUserSPNs.py -dc-ip <dc> -request -outputfile
   kerb.txt '<域>/<可用账密>'`——单次请求即得全部 SPN 账户的 TGS;
2. AS-REP Roast: 先枚举无预认证账户(`GetNPUsers.py <域>/ -usersfile
   <候选> -format hashcat -dc-ip <dc>`; 候选来自 bloodhound-ad 的
   asrep 发现或用户名情报), 无预认证账户无需凭据即可请求;
3. 在线段纪律: 每账户一次请求, 不重放; 失败形态如实记(账户禁用/
   预认证开启=正常阴性)。

## 第二段·离线破解(hashcat)

- Kerberoast TGS: `hashcat -m 13100 kerb.txt --potfile-disable
  /opt/tools/wordlists/rockyou.txt -r /opt/tools/dicts/brute_suffix.rule`
- AS-REP: `-m 18200` 同字典;
- 预算: 默认 rockyou+后缀规则一轮(~30min CPU/分钟级 GPU); 未跑完
  不空转加字典——残留 hash 与进度百分比入台账, 报告标注"未破解≠不可
  破解";
- rc 参考: hashcat 退出码 1=穷尽未命中。

## 第三段·破解后回灌

- 命中 → 弱口令凭据进 publish_intel(标注来源账户/SPN 服务, 供
  weakcred 复用面与 lateral-movement 直接消费);
- 服务账户密码命中常是 critical 前奏: 检查该账户是否域管/可委派
  (回 bloodhound-ad 的 adminCount/路径数据交叉)——这决定定级;
- 未命中 → hash 留档, 后续拿到更大字典再跑(台账留 hashcat 命令行)。

## 证据要求

- 采集段: SPN 账户清单 + 每账户一条 hash 凭据(kerb.txt 行数=账户数);
- 破解段: hashcat 输出摘要(Recovered x/y + 用时)原文留证;
- 保密: 破解出的明文只进情报库(自动留痕), 不在报告正文全文罗列
  (采样量以证明危害为准)。
