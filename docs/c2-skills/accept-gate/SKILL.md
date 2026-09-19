---
name: accept-gate
description: 独立验收协议——自部署环境→全功能实测→干净清理
---

# 独立验收(acceptance gate)
开发者会话(建载荷/建工具)不得自证通过;必须由**独立验收会话**(全新会话,
不继承开发上下文,只读交付物)执行本协议。

## 授权与环境生命周期(铁律)
1. 验收会话自己部署环境,**禁止依赖常驻容器/预装环境**:
   - Java:嵌入式容器(tomcat-embed 9=javax / 10.1=jakarta,jars 在
     /opt/tools/c2/libs)进程内起停,进程亡环境亡
   - PHP:docker run --rm -d php:5.6-apache / php:8.2-apache,测完
     docker rm -f;镜像可缓存,容器不留
   - PS:pwsh -NoProfile 子进程;JS:node shim
   - ARM64:docker --platform linux/arm64(+qemu binfmt 注册检查
     docker run --rm --platform arm64 alpine uname -m 先行探通,探通必测)
   - 安卓:先探可行性(ls /dev/kvm;redroid 需 privileged+binder),
     可行才测,不可行入台账(附探查证据)
2. 环境矩阵分级:能测必测(x64 全家+ARM64 探通后);探查后确不可测
   (macOS/真 Windows/Android-无KVM/WebLogic)逐项论证+探查命令与输出
   入例外台账——先探后跳,禁止想当然跳过
2. 测后清理三查:docker ps 无测试容器/工作目录删净/审计行有始有终
   (deploy 行必有 teardown 行);清理不留痕=验收无效
3. 例外台账(实在无法本地运行,须论证+记录):
   - WebLogic:商业许可+巨型栈,以"容器行为等价+官方文档差异声明"替代
   - 真 Windows WSH/HTA:无 Windows 宿主;以 node shim 语义等价+标注
   - 例外必须每份交付物明示,不许静默降级

## 验收清单(每份 DELIVERY 逐项)
1. 面杀:c2-qa scan(引擎矩阵全绿)
2. 功能:对应环境真执行(内存马=容器 register+触发+回显断言;
   PHP=HTTP 请求含标记;PS=进程输出含标记)
3. 绑定:c2-bind verify 通过且目标匹配
4. 审计:audit.log 行完整(哈希对得上)
5. 环境:部署→测试→teardown 全程记录
6. 判定:全过=ACCEPT(盖章:独立会话 id+时间);任一败=REJECT+复现步骤

## 产出
submit_task_report:验收矩阵(交付物×环境×五项判定)+清理证明+
例外台账核验;REJECT 项回开发会话返工。
