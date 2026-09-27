---
name: scope-gate
description: 授权门——目标清单+时间窗+审计+一次性绑定+EDUSRC 工具层硬隔离
---

# 授权门(硬纪律)
一切载荷生成/检测/交付的前置条件。**工具层已落实,不要只靠会话自觉。**

## 工具层落实表(2026-09-19 起)
| 检查 | 工具/位置 | 违规行为 |
|---|---|---|
| scope 空/出窗 | c2-qa.py gate() / c2-variant.py gen / c2-basetype.py gate() | exit 75 拒绝 |
| EDUSRC 硬隔离 | 同上三处 + functest 不涉及 | 环境旗标 `SPECTRE_EDUSRC=1|true|yes` 或 cwd/载荷路径含 `edusrc` → **exit 76** 拒+审计 |
| 目标不在清单 | c2-bind.py bind | exit 70 |
| 审计 | /opt/tools/c2/audit.log | 每轮扫描/绑定/生成/拒绝全落行 |

## 一次性载荷绑定(c2-bind.py v2,交付协议一部分)
```
c2-bind.py bind --payload p [--target t] [--days N]   # exp 默认=scope 窗口 end,不可超窗
c2-bind.py verify --payload p [--target t]            # 交付前必过
c2-bind.py expire --payload p                          # 人工提前作废
```
退出码语义:0=OK;77=**EXPIRED(过期自废,qa 拒绝交付)**;78=目标越出当前 scope;
79=载荷绑定后被改;80=签名坏;81=无 sidecar;70/75/76 同上。
绑定=HMAC-SHA256(bind.key, sha256|target|exercise|exp);sidecar `<payload>.bind.json` 随交付包。
c2-qa 交付路径已自动 bind+verify;任何下游 agent 拿到交付件先 `verify` 再用。

## 窗口结束纪律
窗口结束:scope gate 全线拒绝(exit 75)≈载荷生成停用;已交付件 verify=EXPIRED(77)自废。
不做"为续期改 scope"的动作——窗口变更走编排器侧重新授权,会话不得自改 scope.json。

## EDUSRC 判定细节
- 旗标:SPECTRE_EDUSRC∈{1,true,yes}(大小写不敏感)
- 路径:cwd、--src/--out、--payload 任一含 "edusrc"(大小写不敏感)
- 拒绝时审计行 action=EDUSRC;**教育 SRC 工作区连 benchmark/本地面杀也不做**(硬纪律,无豁免口)
