---
name: payload-pipeline
description: 载荷生成与变体变换流水线——按目标栈生成内存马/加载器/脚本载荷(jMG real-lane 可跳过变体), 再分层变换(公开技术组装/签名感知分解/功能守恒)
---

# 载荷流水线(线一生成 → 线二变体)

**real-lane(jMG 生成)如无需过检可跳过变体直接交付。**
设计吸收 Sliver/Havoc/Mythic/MemShellParty·jMG 族谱。

## 一、生成层

### 双车道契约(必选其一, manifest 声明)
| 车道 | 内容 | 标记 | QA 适用性 |
|---|---|---|---|
| source-lane | /opt/tools/c2/basetypes/ 源码骨架 | **SPECTRE-MARK 承重** | decomp 文本族+全流水线 |
| real-lane | jMG 真实 class 字节(c2-basetype.py 生成) | manifest sha256/jmg-info | 需字节码变换族(未建, 如实声明) |
| jakarta 道 | javastubs-jakarta/(CS27-13) | RT-COMPILE/RT | c2-functest TC10+STUBS_J |
| reactor 道 | javastubs-rx/ | RT-COMPILE | c2-javart/functest RXSTUB |

### 基型契约(source-lane 新增基型必须满足, 否则不收)
1. **标记承重**: SPECTRE-MARK 必须字面量且参与运行时自证(PS 范式: 解码/求值
   结果≠标记 → CORE-LOST+退出; 不是注释摆设)
2. **基线必须过 c2-functest 最高可得层**: Java 基型必须可编译(javac UTF-8+桩;
   extends 接口/未捕获检查异常类骨架缺陷收录时修掉)
3. **基线引擎命中如实记录**(1-5 条/个, 供 benchmark)

### jMG 真实生成器(v2 已可用)
```
c2-basetype.py gen --engine jmg --server Tomcat --shell Filter --tool Godzilla \
                   --format BASE64 --name jmg_filter_godzilla && c2-basetype.py verify
```
- jmg 产物是"注入器类"而非 Listener/Filter 本体——不能直接 `c2-javart --mode
  listener` 验证(类型不符), 走 manifest sha256/jmg-info 记账验证
- 生成器 /opt/tools/c2/generators/jmg-cli-1.0.9.jar(pen4uin/java-memshell-generator);
  输出落 /opt/tools/c2/basetypes-jmg/(勿混入 benchmark 基型目录)
- **实测警告: jMG 1.0.9 生成物硬依赖 sun.misc.BASE64Decoder(JDK8 API)——JDK9+
  目标 NoClassDefFoundError; yara ENG06/ENG17 双命中(常量池明文)。JDK9+ 目标
  优先走源码车道或要求 jMG 输出 java.util.Base64 模板**

### 真实验证栈(环境)
javac17+servlet/spring 桩(/opt/tools/c2/javastubs/{classes,patchsrc}, Java 编译级,
sun.misc 走 --patch-module); node+WSH shim(/opt/tools/c2/jsshim/wsh-shim.js, JS
运行时等价 ProgID 实证); pwsh 7.4.6(/usr/local/bin/pwsh, PS 自证); php 8.2
(/usr/bin/php, lint+实跑)。

### 注入位/协议选新令(2026-09)
- 内存马优先新注入点(研究覆盖低=厂商特征少): Valve/Pipeline、Upgrade/WebSocket、
  HandlerAdapter、WebFlux/Spring Cloud Gateway 钩子、编解码器位; 经典五位仅
  基线兜底, 退回须附理由; 维护覆盖度台账
- 经典协议(Godzilla/冰蝎/Suo5 兼容)默认禁用——特征深耕区; 仅目标环境强制互连
  时例外+留档。优先自研新协议形态(业务 JSON 包裹/自定义定界/JA3·H2 拟态/
  每会话随机密钥), 配新注入位交付并注明形态

## 二、变体层(/opt/tools/bin/c2-variant.py, 公开技术分层组装不发明新原语)

**回归纪律: 改本文件后跑 `c2-variant.py selftest` 必须 10/10 OK 才算改完。**

### 变换族
| 族 | 技术 | 适用 | 备注 |
|---|---|---|---|
| decomp | 签名感知分解(下表) | 一切文本载荷首选 | 单轮清当前全部命中串 |
| id | 类名/变量名随机+语言感知垃圾注释 | shape 多样性 | php 变量重命名跳过超全局 |
| enc | XOR 演示桩 | 仅配合真实加载桩模板 | 无模板=守卫必弃, 勿单独用 |
| code | 自定义字母表 b64 桩 | 同上 | 同上 |
| struct | 垃圾注释 | 叠加用 | 对字符串规则零效, 勿单独抽中赌轮次 |

### decomp 适用判定(语言×改写技术, 全部公开图谱)
| 语言 | 字符串字面量 | 代码位·调用 | 标识符/注解/类型名 | 注释位 |
|---|---|---|---|---|
| Java | 单字符 `\uXXXX`(JLS§3.3, 值不变) | 同左 | 同左(编译等价) | 同左(惰性) |
| PHP | 拆分 `'a'.'b'` | `('a'.'b')(...)` 可变函数 | `$var` 交 id 族; `$_SUPER`→`${'_RE'.'QUEST'}`(lint 失败回退) | 拆分(惰性) |
| JS | 拆分 `"a"+"b"` | `new X`→`new this["a"+"b"]` | 无转义机制, 跳过 | 拆分(惰性) |
| PS | 拆分 `"a"+"b"` | `[T]::m(`→`[T]::$m(`、`p.m(`→`p.$m(`+hoist | 同左 | 拆分(惰性) |

判定实现: yara -s 取命中串→按 string_mask(字面量/注释/代码三态)逐出现点
右→左改写→**改写全部出现点**(规则只需一处存活即命中)。

### 语言感知注释纪律(违反=功能破坏, 实测教训)
- ps 只认 `#`;`//` 与 `/* */` 在 PowerShell 是语法错误
- php 垃圾注释必须落在 `<?php` 块内(块外 `//` 被当原文输出);php/ps 用行尾
  注释追加, java/js 才可用独立 `/* */` 块
- 扩展名归一(仅内部逻辑): ps1/psm1→ps, hta/jscript→js;**输出保留原始扩展名**

### 功能核守卫协议
任何族变换后必须: ①`SPECTRE-MARK` 字面量仍在; ②php 过 `php -l`。不过守卫的
候选如实弃用(manifest 记 guard:fail), **绝不"标记注水"**(把标记写进桩注释
糊弄守卫=纪律违规)。

### 用法
```
c2-variant.py gen --src p --out d --rounds 4 --families decomp,id,struct \
                  [--rules DIR] [--corpus /opt/tools/c2/corpus.json]
c2-variant.py selftest [--basetypes DIR] [--rules DIR]   # 改完必跑, 10/10 才收工
```
- decomp 入选即必选先行, 其余族随机 0-2 叠加(diversity); corpus 查重: 同 sha
  变体不重复交付(防撞库重放)
- 策略选择按检测报告反查: YARA 字符串命中→decomp; 行为特征→struct 叠加

### 已知边界(如实)
- real-lane(jMG class 字节)不适用本引擎: 需字节码变换族(常量池串加密/重排), 未建
- enc/code 桩及无回显 agent 型打入均需目标栈真实加载桩模板(Tomcat/Spring
  Agent 型), 无模板前不得交付

### 伪装守恒(变体不得破坏伪装)
变换后复查全部伪装面: 密钥仍随机/文件名路径仍中性/头部字段仍拟态/jitter 仍在/
填充仍随机/线程名仍中性/响应 JSON 包裹仍完整/栈仍吞净——变体把任一伪装面
变没了=功能守恒同罪(弃用该候选)。
