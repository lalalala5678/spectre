#!/bin/bash
# 第三方 jar 依赖装载(~25MB 不入 git, 首次部署下载)
# 目标: $SPECTRE_DATA_DIR/tools/c2/{libs,generators}(挂载进容器为 /opt/tools/c2/*)
# 任何一项失败都会在结尾汇总报错并以非零退出(不静默吞)。
ROOT=${SPECTRE_DATA_DIR:-/var/lib/spectre}
# R14-1(十四轮): 生产缺省守卫——同族 tools-sync/skills-seed 已三修, 此为
# 最后缺位者(漏 env 直跑即静默写 ~25MB jar 进生产路径)。
# CS3-N19: 守卫判实际写目标(LIBS/GEN 可覆盖 ROOT), 而非仅 ROOT
GUARD_BASE=${LIBS_DIR:-$ROOT/tools/c2/libs}
if [ -z "$SPECTRE_DATA_DIR" ] && [ "$GUARD_BASE" = "/var/lib/spectre/tools/c2/libs" ]; then
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
fetch . "$MVN"/org/apache/tomcat/embed/tomcat-embed-core/10.1.39/tomcat-embed-core-10.1.39.jar tomcat-embed-core-10.1.39.jar
fetch . "$MVN"/jakarta/annotation/jakarta.annotation-api/2.1.1/jakarta.annotation-api-2.1.1.jar jakarta.annotation-api-2.1.1.jar
# 字节码变换(ASM 9.x)
fetch . "$MVN"/org/ow2/asm/asm/9.7/asm-9.7.jar asm-9.7.jar
fetch . "$MVN"/org/ow2/asm/asm-commons/9.7/asm-commons-9.7.jar asm-commons-9.7.jar
# Spring 编译桩(按 javastubs/patchsrc 声明的版本补齐; 显式坐标, 失败汇总)
mkdir -p spring
fetch spring "$MVN"/org/springframework/spring-core/5.3.39/spring-core-5.3.39.jar spring-core-5.3.39.jar
fetch spring "$MVN"/org/springframework/spring-web/5.3.39/spring-web-5.3.39.jar spring-web-5.3.39.jar
fetch spring "$MVN"/org/springframework/spring-context/5.3.39/spring-context-5.3.39.jar spring-context-5.3.39.jar
fetch spring "$MVN"/org/springframework/spring-beans/5.3.39/spring-beans-5.3.39.jar spring-beans-5.3.39.jar
# jMG 真实载荷生成器(上游 pen4uin/java-memshell-generator, tag v1.0.9_250101)
fetch "$GEN" https://github.com/pen4uin/java-memshell-generator/releases/download/v1.0.9_250101/jmg-cli-1.0.9_250101.jar jmg-cli-1.0.9_250101.jar
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "[fetch-jars] ✗ 失败 ${#FAILED[@]} 项: ${FAILED[*]}"; exit 1
fi
echo "[fetch-jars] 完成: $LIBS + $GEN"
