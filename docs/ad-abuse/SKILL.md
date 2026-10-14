---
name: ad-abuse
description: AD 权限滥用落地——bloodhound 路径→DCSync/GPP/ACL/委派的执行面
---

# AD 权限滥用执行面(postex/AD 深度)

[runs commands; side-effects] 输入: spectre-bloodhound.py 的 analyze 产出
(DA 路径/Kerberoast 候选/adminCount 残迹)。本技能是"路径→利用"的落
地半段: 路径上每类边的实际滥用手法与最小化纪律。

## 各边执行面(按路径常见度)

### DCSync(到 DA 最短边之一)
- 前提: 当前账户拥有 GetChanges/GetChangesAll(域管/管理员组/
  已被滥用的 ACL 授予——bloodhound 路径应已标明边的来源);
- 执行: `secretsdump.py -just-dc-user krbtgt -dc-ip <dc>
  '<域>/<账:密或 -hashes>'`——**只取 krbtgt 一个账户**(证明金票
  能力即停), 禁全量 `-just-dc`(=拖库红线; krbtgt 单条即完整取证);
- 证明: krbtgt NT hash 入情报库(标注"DCSync 已实证"), 报告定级
  critical 候选; 不铸造金票(能力证明≠必须使用)。

### GPP cpassword(历史遗留边)
- `Get-GPPPassword.py -dc-ip <dc> '<域>/<凭据>'` 批量取 Groups.xml
  等里的 cpassword → AES 固定公钥解密(工具内置)→ 明文;
- 该边零交互零告警, 命中即凭据面扩大, 全部进 publish_intel。

### ACL 滥用(GenericAll/WriteDacl/WriteOwner/ForceChangePassword)
- GenericAll(用户/组): 改目标密码→登录(`net user` 经 smbexec 或
  impacket 的 samr 接口); 组对象则把自己加入组;
- WriteDacl: 给自己加 DCSync 权限→转 DCSync 边(改动前**先快照原
  ACL**——恢复用, trace-cleanup 台账记录);
- ForceChangePassword: 重置目标密码(高扰动——仅当目标账户是路径
  必经点, 且台账记原 hash 便于恢复判断)。

### 委派(非约束/约束/RBCD)
- 非约束: 拿到有 SPN 的服务账户凭据后经它请求→转 Kerberoast/
  PassTheTicket 面; 判定优先于执行(约束委派清单 via bloodhound
  的 msDS-AllowedToDelegateTo);
- RBCD: 需机器账户写权(GenericAll on computer)——加机器账户+
  msDS-AllowedToActOnBehalfOfIdentity 注入。步骤多扰动大, 仅在
  路径无更短边时用。

## 最小化纪律(全部边共用)

1. **先路径后执行**: 每次滥用前 bloodhound 路径里该边必有出处;
   路径外的"顺手试"不做;
2. **改动可回滚**: ACL/密码/组成员三类改动必须先快照(原值入台账)
   ——战役收尾按 trace-cleanup 恢复;
3. **逐边留证**: 每条边执行后的 whoami/成员查询回执原文;
4. **DC 专检**: 域控上只做读取类(DCSync/GPP 查询), 不投递不改配置。

## 停止条件

- 路径走通(DA 或等效能力到手)即收官——后续按 persistence 席位
  指令决定是否维持, 不自行展开;
- 边执行失败(权限不足/EDR 拦截)→ 台账记失败形态, 换下一边, 不重试
  超过 2 次。
