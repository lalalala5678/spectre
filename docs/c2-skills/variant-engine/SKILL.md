---
name: variant-engine
description: 分层变换管道——公开技术组装的变体生成(v2.2 含 decomp 签名感知分解)
---

# 变体引擎(线二,/opt/tools/bin/c2-variant.py)
公开 BypassAV 图谱内的技术分层组装,不发明新原语。
**回归纪律:任何对本文件的修改,跑 `c2-variant.py selftest` 必须 10/10 OK 才算改完。**

## 变换族
| 族 | 技术 | 适用 | 备注 |
|---|---|---|---|
| decomp | 签名感知分解(见下表) | 一切文本载荷首选 | 单轮清当前全部命中串 |
| id | 类名/变量名随机+语言感知垃圾注释 | shape 多样性 | php 变量重命名跳过超全局 |
| enc | XOR 演示桩 | 仅配合真实加载桩模板 | 无模板=守卫必弃,勿单独用 |
| code | 自定义字母表 b64 桩 | 同上 | 同上 |
| struct | 垃圾注释 | 叠加用 | 对字符串规则零效,勿单独抽中赌轮次 |

## decomp 适用判定表(语言×上下文×改写技术,全部公开图谱)
| 语言 | 字符串字面量 | 代码位·调用 `name(` | 代码位·标识符/注解名/类型名 | 注释位 |
|---|---|---|---|---|
| Java | 单字符 `\uXXXX`(JLS§3.3 词法前翻译,值不变) | 同左 | 同左(注解名/类型名可转义,编译等价) | 同左(惰性) |
| PHP | 拆分 `'a'.'b'` | `('a'.'b')(...)` 可变函数 | `$var` 交 id 族;`$_SUPER`→`${'_RE'.'QUEST'}`(lint 失败自动回退跳过) | 拆分(惰性) |
| JS | 拆分 `"a"+"b"` | `new X`→`new this["a"+"b"]` 计算成员 | 无转义机制,跳过(id/其它轮兜底) | 拆分(惰性) |
| PS | 拆分 `"a"+"b"` | `[T]::m(`→`[T]::$m(`、`p.m(`→`p.$m(`+hoist 文件头 | 同左 | 拆分(惰性) |

判定实现:yara -s 取命中串→按 string_mask(字面量/注释/代码三态)逐出现点右→左改写→**改写全部出现点**(规则只需一处存活即命中)。

## 语言感知注释纪律(违反=功能破坏,实测教训)
- ps 只认 `#`;`//` 与 `/* */` 在 PowerShell 是语法错误
- php 垃圾注释必须落在 `<?php` 块内;块外 `//` 会被当原文输出(污染 header 场景)
- php/ps 用行尾注释追加,java/js 才可用独立 `/* */` 块
- 扩展名归一(仅内部逻辑):ps1/psm1→ps,hta/jscript→js;**输出文件保留原始扩展名**

## 功能核守卫协议
任何族变换后必须:①`SPECTRE-MARK` 字面量仍在;②php 过 `php -l`。不过守卫的候选如实弃用(manifest 记 guard:fail),**绝不"标记注水"**(把标记写进桩注释来糊弄守卫=纪律违规)。

## 用法
```
c2-variant.py gen --src p --out d --rounds 4 --families decomp,id,struct \
                  [--rules /path/rules] [--corpus /opt/tools/c2/corpus.json]
c2-variant.py selftest [--basetypes DIR] [--rules DIR]   # 改完必跑,10/10 才收工
c2-variant.py fingerprint <file>
```
- decomp 入选即必选先行,其余族随机 0-2 叠加(diversity)
- corpus 查重:同 sha 变体不重复交付(防撞库重放)
- 策略选择仍按检测报告反查:YARA 字符串命中→decomp;行为特征→struct 叠加

## 已知边界(如实)
- real-lane(jMG class 字节)不适用本引擎:需字节码变换族(常量池串加密/重排),未建
- enc/code 桩需目标栈真实加载桩模板(Tomcat/Spring Agent 型)才有意义

## 伪装守恒(2026-09 用户两令,变体不得破坏伪装)
变换后必须复查全部伪装面:密钥仍随机/文件名路径仍中性/头部字段仍拟态/
jitter 仍在/填充仍随机/线程名仍中性/响应 JSON 包裹仍完整/栈仍吞净——
变体把任一伪装面变没了=功能守恒同罪(弃用该候选)。
