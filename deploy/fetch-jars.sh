#!/bin/bash
# 第三方 jar 依赖装载(15M libs + 25M generators 不入 git, 首次部署下载)
# 目标: /opt/tools/c2/libs 与 /opt/tools/c2/generators(挂载到容器同路径)
set -e
LIBS=/opt/tools/c2/libs
GEN=/opt/tools/c2/generators
mkdir -p "$LIBS" "$GEN"
cd "$LIBS"

MVN=https://repo1.maven.org/maven2
fetch() { [ -f "$(basename $2)" ] || curl -fsSL -o "$(basename $2)" "$1/$2"; }

# Tomcat 9(javax)/10.1(jakarta) 嵌入式桩
fetch $MVN/org/apache/tomcat/embed/tomcat-embed-core/9.0.106 tomcat-embed-core-9.0.106.jar
fetch $MVN/org/apache/tomcat/embed/tomcat-embed-core/10.1.39 tomcat-embed-core-10.1.39.jar
fetch $MVN/org/apache/tomcat/tomcat-annotations-api/6.0.53 annotations-api-6.0.53.jar
fetch $MVN/jakarta/annotation/jakarta.annotation-api/2.1.1 jakarta.annotation-api-2.1.1.jar
# 字节码变换(ASM 9.x)
fetch $MVN/org/ow2/asm/asm/9.7 asm-9.7.jar
fetch $MVN/org/ow2/asm/asm-commons/9.7 asm-commons-9.7.jar
# Spring 编译桩(按 javastubs/patchsrc 声明的版本补齐)
mkdir -p spring && cd spring
for a in spring-core/spring-core/5.3.39 spring-web/spring-web/5.3.39 \
         spring-context/spring-context/5.3.39 spring-beans/spring-beans/5.3.39; do
  fetch $MVN/org/springframework/$a "$(echo $a | tr '/' '-' | sed 's/-[0-9.]*$/-&/;s/^.*-\([0-9][0-9.]*\)$/x/;s/x//').jar" 2>/dev/null || true
done
cd "$GEN"
# jMG 真实载荷生成器(上游 pen4uin/java-memshell-generator)
JMG=jmg-cli-1.0.9.jar
[ -f "$JMG" ] || curl -fsSL -o "$JMG" \
  https://github.com/pen4uin/java-memshell-generator/releases/download/v1.0.9/jmg-cli-1.0.9.jar
sha256sum "$JMG" | grep -qi 31186f1 || echo "[警告] jmg jar 指纹不符, 校验后使用"
echo "[fetch-jars] 完成: $LIBS + $GEN"
