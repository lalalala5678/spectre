# Lint 配置与豁免理由(单源记载)

commit 4ce5e1d 曾把 console oxlint 告警从 34 清到 0, 提交信息自称"理由注于
lint script"——但 JSON 配置无法注释、lint script 就是裸 `oxlint`, 理由实际
无处落盘(CS1-B12)。本文件是唯一记载处, 改动豁免必须同步改这里。

## console/.oxlintrc.json 关闭的 5 条规则

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
