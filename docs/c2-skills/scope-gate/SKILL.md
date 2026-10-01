---
name: scope-gate
description: 授权门——目标清单+时间窗+审计+一次性绑定+EDUSRC 工具层硬隔离
---

# 授权门(硬纪律)
一切载荷生成/检测/交付的前置条件。**工具层已落实,不要只靠会话自觉。**

## scope.json 权威样例(字段 schema 唯一记载处——R32D38 观-1)

```json
{
  "targets": ["*.target-range.example", "203.0.113.0/24"],
  "exercise": "EX-2026-渗投-042",
  "window": {"start": "2020-01-01T00:00:00Z", "end": "2099-01-01T00:00:00Z"}
}
```

> 注: window 起止改成你的演练窗口(UTC ISO-8601)——上面的宽窗口仅为
> 逐字可用的占位(样例本身是合法 JSON, 可直接拷贝后改字段)。

三必填字段: `targets`(glob/网段清单)、`exercise`(本次演练标识, 入审计
账)、`window`(UTC ISO-8601, 起止闭区间)。位置: 数据根 `tools/c2/scope.json`
(容器视角 `/opt/tools/c2/scope.json`)。缺任一 → `SCOPE-REJECT` exit 75。

## 工具层落实表(2026-09-19 起)
| 检查 | 工具/位置 | 违规行为 |
|---|---|---|
| scope 空/出窗 | c2-qa.py gate() / c2-variant.py gen / c2-basetype.py gate() | exit 75 拒绝 |
| EDUSRC 硬隔离 | 同上三处 + functest 不涉及 | **仅**环境旗标 `SPECTRE_EDUSRC=1|true|yes`(或值含 edusrc)→ **exit 76** 拒; cwd/路径启发式已废(R32D58 用户裁定: 不误伤正常使用) |
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
- 旗标:SPECTRE_EDUSRC∈{1,true,yes}, 或值含 "edusrc"(大小写不敏感)——**唯一触发条件**
- 路径/cwd 启发式已废除(R32D58 用户裁定: 目录名碰巧含 edusrc 不影响任何工具正常使用)
- 审计留痕仅 c2-qa gate(action=EDUSRC); variant/basetype/bytecode 拒绝不落审计行
- **教育 SRC 工作区连 benchmark/本地面杀也不做**(硬纪律,无豁免口)
