---
name: payload-gen
description: 按目标栈生成内存马/加载器/脚本载荷
---

# 载荷生成(线一)
[creates artifacts] 目标栈匹配优先,协议兼容其次。

## Java 内存马(主力)
- 族谱(Tomcat7-10/Spring/Resin/Weblogic)×注入位(Listener/Filter/Servlet/
  Controller/HandlerInterceptor/WebSocket)×协议(Godzilla/冰蝎/Suo5/自定义)
- 参考 MemShellParty/jMG 生成逻辑;无回显 RCE 场景=Agent 型打入
  (premain/attach 两条路)
- 密码/密钥/路径每次生成随机;字节码层避免明文特征(交给变体引擎)
## 加载器(EXE)
- 分离式:加密资源段+运行时解密+反射/回调加载
- 直接系统调用:公开 syscall 框架用法,不新写原语
## 脚本类
- PHP 变体(assert/回调/加密会话)/PS AMSI 感知/JScript HTA
## 功能自测(必过)
每个载荷先在本地同栈环境执行 PoC 行为(echo 唯一标记/环境自证),
响应含标记才算功能守恒。自测不过的变体直接弃,不送检测。
