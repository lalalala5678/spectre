# Lint 配置与豁免理由(单源记载)

commit 4ce5e1d 曾把 console oxlint 告警从 34 清到 0, 提交信息自称"理由注于
lint script"——但 JSON 配置无法注释、lint script 就是裸 `oxlint`, 理由实际
无处落盘(CS1-B12)。本文件是唯一记载处, 改动豁免必须同步改这里。

## console/.oxlintrc.json 关闭的规则(CS6-F8: 现役 3 条——only-export-components/exhaustive-deps 已恢复全局)

| 规则 | 关闭理由 | 复核结论(CS1) |
|---|---|---|
| ~~`react/only-export-components`~~ | (CS2-#7 已恢复全局) | getAgent/NAV 已挪 api/agentMeta.ts 与 components/nav.ts, 规则开启且 0 违例 |
| ~~`react-hooks/exhaustive-deps`~~ | (CS2-#7 已恢复全局) | 逐点 disable+注释 7 处(6 处 next-line + useBusPanelEntries 1 处 line 尾注——CS4-M12 逐文件复核); R3-2 类回归恢复机器防线 |
| `react/refs` | LiveSession 渲染期写 ref ×4 服务 SSE 闭包最新值语义(均带注释) | 知情豁免可接受; React 19 并发下非严格安全, 无第二文件效仿 |
| `react/set-state-in-effect` | 会话切换清场模式, React 官方三方案之一 | 无 effect 级联死循环, 豁免可接受 |
| `react/immutability` | react-compiler 前置分析, 当前未启用 compiler | 纯前瞻豁免 |

## backend 零 lint(补齐于 CS 批次)

backend 7.8k 行此前无任何 linter(CS1-C9), `package.json` 已加
`npm run lint`(oxlint correctness 集)。死 import/死变量从此有机器拦截。

## no-undef(CS2-#9 补)

backend/.oxlintrc.json 显式 `{"env":{"node":true},"rules":{"no-undef":"error"}}`
——R8/R17 两处重构断裂(未导入标识符)曾从语法检查+默认 lint 双防线漏网,
undefined-identifier 类回归纳入基线。oxlint 版本两侧对齐 ^1.86.0(CS2-#19)。

## gateway(PEP8)

`gateway/setup.cfg` 配置 pycodestyle; 全量通过基线:

    PYTHONPATH=/opt/tools/py python3 -m pycodestyle gateway/

## 事故记载(CS11-1/2: 批次 P 粘贴覆写, 2026-10-01)

批次 P(9c0fa4a)发生两起编辑事故: 把 spectre-arl.py / phishlet-proxy.py
的内容整体粘贴覆写了 docs/c2-payload-spec.py / docs/phish-proxy.py, 随后
的 CS10-4/5/6"修复"落在了覆写副本上——提交信息三处失实(硬编码归零/
TODO 注释/SPEC_DIR 所述对象不存在)。两文件已从 git 历史(9c0fa4a^)
恢复并在原文件上重做修复; 机锁 v4(twin-parity)新增跨文件内容查重
(>90% 相似即红)与技能清单运行时枚举集合相等断言, 封堵此类事故的
公共盲区。教训: 相邻同名族文件批量 sed 后必须按文件头 docstring 抽查
身份, 不能只看 lint/parity 绿灯。

## 编辑纪律补记(CS20 对账: AE 提交信息承诺未落盘)

- 改编号/标题/锚点(如 README 步骤号、段落标题)= 全仓 grep 旧引用入边
  后再改(CS19-1: 删 ⑦ 后 deploy/README 残留唯一入边悬空)。
- python json 写回须 ensure_ascii=False——默认转义会把中文值改写成
  \\uXXXX 等价但未披露的变更(CS18-F9 实例)。
- 正则替换多段式表格/注释时, 锚点必须吃满整段([^)]* 在含括号文本上
  只吃到首个右括号, CS18-F1 留下新旧两套数字)。

## 对账失实更正(CS28 实锤, 2026-10-01)

批次 AR/AS(3e28b8d)宣称"CS27 十五项+R32D52 六项全修", 实测:
- CS27-1/5/6/7 四项零改动(编辑脚本漏 write_text——shells.mjs 替换在
  内存完成后未落盘, 提交时无该文件 hunk)
- "死 import 16 处清"实删 10, 余 22(点名的 argparse 本身未删)
- N4"不谎报 ok"未动真正产出 ok:true 的 ensureSandbox 两处
教训: 编辑脚本必须 write 后回读断言; 提交前 git diff --stat 对账
提交信息枚举的每个文件。CS30 对账: 本段(AT 轮)所列补修在 AU 轮
(d910593)才全部落盘——AT 轮自身仍有 CLI 三态虚报(toklab/basetype
真调用 NameError)与死 import 数字虚报, 连续第四轮。

## 对账失实第五轮(CS32 实锤, 2026-10-01)

批次 AY(deade89)宣称"引擎缺失家族契约: yara/php SKIP+selftest
stderr", 实测 git log c2-variant.py 在该提交零 hunk——php SKIP 与
selftest stderr 均未落盘(又是内存完成未 write_text); c2-bytecode
yara 守卫落盘但返回 (0,[]) 与调用侧 hits 形状断裂(split/selftest
TypeError), 即"修而即坏"——无引擎缺失环境的活体验证。
成文纪律(此后每批必守, 违者按对账失实记档):
1. 每个 python -c/替换脚本后立即回读断言(grep 目标串在文件中);
2. 提交前 git diff --stat 逐文件对账提交信息枚举项;
3. 守卫/降级类修复必须在其触发环境活体验证(删引擎 PATH 重跑)。

## BS 批次勘误(CS45-N4, 2026-10-02)

BS(d49aa02)提交信息列"F11 颜色注释如实"但该 hunk 实际未落盘
(编辑脚本 replace 目标串与现场文本不符, 未断言即静默跳过)——第六轮
对账失实实例。F11 已在 BV 批次补落(IntelNotesPanel Emerald→Teal)。
教训并入既有三条款: 无断言的 replace 不得视为已修。
