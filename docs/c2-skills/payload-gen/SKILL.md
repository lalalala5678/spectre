---
name: payload-gen
description: 按目标栈生成内存马/加载器/脚本载荷(双车道契约+真实验证栈)
---

# 载荷生成(线一)
设计吸收:Sliver(按目标定制)/Havoc(模块化)/Mythic(载荷-传输分离)/
MemShellParty·jMG 族谱(中间件×注入位×协议兼容)。

## 双车道契约(必选其一,manifest 声明)
| 车道 | 内容 | 标记 | QA 适用性 |
|---|---|---|---|
| source-lane | /opt/tools/c2/basetypes/ 源码骨架 | **SPECTRE-MARK 承重**(见下) | decomp 文本族+全流水线 |
| real-lane | jMG 真实 class 字节(c2-basetype.py 生成) | manifest sha256/jmg-info | 需字节码变换族(未建,如实声明) |

## 基型契约(source-lane 新增基型必须满足,否则不收)
1. **标记承重**:SPECTRE-MARK 必须是字面量且参与运行时自证
   (PS 范式:解码/求值结果 ≠ 标记 → CORE-LOST + 退出;不是注释摆设)
2. **基线必须过 c2-functest 最高可得层**:Java 基型必须可编译
   (javac -encoding UTF-8 + 桩;extends 接口/未捕获检查异常这类骨架缺陷在收录时修掉)
3. **基线引擎命中如实记录**(1-5 条/个为宜,供 benchmark)

## jMG 真实生成器接入(v2,已可用)
```
c2-basetype.py list serverTypes|shellTypes|formatTypes
c2-basetype.py gen --engine jmg --server Tomcat --shell Filter --tool Godzilla \
                   --format BASE64 --name jmg_filter_godzilla
c2-basetype.py verify
```
- 生成器:/opt/tools/c2/generators/jmg-cli-1.0.9.jar(sha256=31186f1e…,上游 pen4uin/java-memshell-generator)
- 输出落 /opt/tools/c2/basetypes-jmg/(勿混入 benchmark 基型目录)
- **实测警告:jMG 1.0.9 生成物硬依赖 sun.misc.BASE64Decoder(JDK8 API)——
  JDK9+ 目标运行时 NoClassDefFoundError;yara ENG06/ENG17 双命中(常量池明文)。
  目标栈 JDK9+ 时优先走源码车道或要求 jMG 输出改用 java.util.Base64 的模板。**

## 真实验证栈(环境,2026-09-19 起)
| 组件 | 位置 | 用途 |
|---|---|---|
| javac 17 + servlet/spring 桩 | /opt/tools/c2/javastubs/{classes,patchsrc} | Java 编译级验证(sun.misc 走 --patch-module) |
| node + WSH shim | /opt/tools/c2/jsshim/wsh-shim.js | JS 运行时等价(ProgID 实证) |
| pwsh 7.4.6 | /usr/local/bin/pwsh | PS 运行时自证 |
| php 8.2 | /usr/bin/php | PHP lint+实跑 |

## 无回显场景
Agent 型打入(jar agent / JAR_AGENT 输出),配合目标栈真实加载桩模板;
enc/code 桩族在没有模板前不得交付。

## 注入位选新令(2026-09 三令)
内存马优先新注入点/机制(研究覆盖低=厂商特征少):Valve/Pipeline、
Upgrade/WebSocket、HandlerAdapter、WebFlux/Spring Cloud Gateway 钩子、
线程池 Runnable 包装、编解码器位;经典五位仅基线兜底;维护注入位
研究覆盖度台账(低覆盖优先,随公开研究动态更新);退回经典位须附理由。
