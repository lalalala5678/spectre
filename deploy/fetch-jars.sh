#!/bin/bash
# 第三方 jar 依赖装载(~25MB 不入 git, 首次部署下载)
# 目标: $SPECTRE_DATA_DIR/tools/c2/{libs,generators}(挂载进容器为 /opt/tools/c2/*)
# 任何一项失败都会在结尾汇总报错并以非零退出(不静默吞)。
ROOT=${SPECTRE_DATA_DIR:-/var/lib/spectre}
# R14-1(十四轮): 生产缺省守卫——同族 tools-sync/skills-seed 已三修, 此为
# 最后缺位者(漏 env 直跑即静默写 ~25MB jar 进生产路径)。
# CS3-N19: 守卫判实际写目标(LIBS/GEN 可覆盖 ROOT), 而非仅 ROOT
# CS3-N19/CS4-M11: 守卫判全部实际写目标(LIBS 与 GEN 任一落在生产路径即拦)
GUARD_LIBS=${LIBS_DIR:-$ROOT/tools/c2/libs}
GUARD_GEN=${GEN_DIR:-$ROOT/tools/c2/generators}
if [ -z "$SPECTRE_DATA_DIR" ] \
   && { [ "$GUARD_LIBS" = "/var/lib/spectre/tools/c2/libs" ] \
     || [ "$GUARD_GEN" = "/var/lib/spectre/tools/c2/generators" ]; }; then
  if [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
    echo "[fetch-jars] 拒绝: 未设 SPECTRE_DATA_DIR 且目标为生产缺省路径 $ROOT" >&2
    echo "[fetch-jars] 设 SPECTRE_DATA_DIR=<隔离目录>, 或显式 SPECTRE_ALLOW_DEFAULT_DATA=1" >&2
    exit 1
  fi
  echo "[fetch-jars] 警告: SPECTRE_ALLOW_DEFAULT_DATA=1 —— 写入生产路径 $ROOT" >&2
fi
LIBS=${LIBS_DIR:-$ROOT/tools/c2/libs}
GEN=${GEN_DIR:-$ROOT/tools/c2/generators}
mkdir -p "$LIBS" "$GEN"
FAILED=()
fetch() { # fetch <目录> <完整URL> <文件名>
  local dir=$1 url=$2 name=$3
  [ -f "$dir/$name" ] && return 0
  if curl -fsSL --retry 2 -o "$dir/$name" "$url"; then
    echo "  ✓ $name"
  else
    rm -f "$dir/$name"; echo "  ✗ $name ← $url"; FAILED+=("$name")
  fi
}
MVN=https://repo1.maven.org/maven2
cd "$LIBS"
# Tomcat 9(javax)/10.1(jakarta) 嵌入式桩 + 注解 API
fetch . "$MVN"/org/apache/tomcat/embed/tomcat-embed-core/9.0.106/tomcat-embed-core-9.0.106.jar tomcat-embed-core-9.0.106.jar
fetch . "$MVN"/org/apache/tomcat/embed/tomcat-embed-core/10.1.42/tomcat-embed-core-10.1.42.jar tomcat-embed-core-10.1.42.jar
fetch . "$MVN"/jakarta/annotation/jakarta.annotation-api/2.1.1/jakarta.annotation-api-2.1.1.jar jakarta.annotation-api-2.1.1.jar
# 字节码变换(ASM 9.x)
fetch . "$MVN"/org/ow2/asm/asm/9.7/asm-9.7.jar asm-9.7.jar
fetch . "$MVN"/org/ow2/asm/asm-commons/9.7/asm-commons-9.7.jar asm-commons-9.7.jar
# CS25-N2/R32D50-F2/F3: jar 供给面与工具引用对齐(此前三套口径错位——
# 供 10.1.39/spring5.3.39×4/jmg-cli-1.0.9_250101, 工具引 10.1.42/
# spring6.0.9×8/annotations-api-6.0.53/jmg-all+短名 jmg-cli)。
fetch . "$MVN"/org/apache/tomcat/annotations-api/6.0.53/annotations-api-6.0.53.jar annotations-api-6.0.53.jar
# Spring 编译桩(c2-functest/c2-javart SPRING 类路径 8 jar; 显式坐标, 失败汇总)
mkdir -p spring
for a in spring-webmvc spring-web spring-core spring-context spring-beans spring-expression spring-aop spring-jcl; do
  fetch spring "$MVN"/org/springframework/$a/6.0.9/$a-6.0.9.jar $a-6.0.9.jar
done
# jMG 真实载荷生成器(上游 pen4uin/java-memshell-generator, tag v1.0.9_250101)
JMG=https://github.com/pen4uin/java-memshell-generator/releases/download/v1.0.9_250101
fetch "$GEN" "$JMG"/jmg-cli-1.0.9_250101.jar jmg-cli-1.0.9_250101.jar
fetch "$GEN" "$JMG"/jmg-all-1.0.9_250101.jar jmg-all-1.0.9_250101.jar
# c2-basetype 引用短名 jmg-cli-1.0.9.jar(md5 实证=同 release 资产重命名)
[ -f "$GEN/jmg-cli-1.0.9.jar" ] || cp "$GEN/jmg-cli-1.0.9_250101.jar" "$GEN/jmg-cli-1.0.9.jar"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "[fetch-jars] ✗ 失败 ${#FAILED[@]} 项: ${FAILED[*]}"; exit 1
fi
echo "[fetch-jars] 完成: $LIBS + $GEN"
