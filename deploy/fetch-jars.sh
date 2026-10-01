#!/bin/bash
# 第三方 jar 依赖装载(~51MB 实测, 不入 git, 首次部署下载)
# 目标: $SPECTRE_DATA_DIR/tools/c2/{libs,generators}(挂载进容器为 /opt/tools/c2/*)
# 任何一项失败都会在结尾汇总报错并以非零退出(不静默吞)。
set -u  # CS44-F19: 族旗标对齐(-e 不用: 累积式失败汇总靠显式 exit)
ROOT=${SPECTRE_DATA_DIR:-/var/lib/spectre}
# R14-1(十四轮): 生产缺省守卫——同族 tools-sync/skills-seed 已三修, 此为
# 最后缺位者(漏 env 直跑即静默写 ~51MB jar 进生产路径)。
# CS3-N19: 守卫判实际写目标(LIBS/GEN 可覆盖 ROOT), 而非仅 ROOT
# CS3-N19/CS4-M11: 守卫判全部实际写目标(LIBS 与 GEN 任一落在生产路径即拦)
# R32D55-N2: realpath 归一——尾斜杠/./ 变体此前绕过守卫写生产。
GUARD_LIBS=$(realpath -m "${LIBS_DIR:-$ROOT/tools/c2/libs}")
GUARD_GEN=$(realpath -m "${GEN_DIR:-$ROOT/tools/c2/generators}")
# R32D55-N2(真修): 按解析后目标判(env 已设的尾斜杠变体此前绕过)。
if [ "$GUARD_LIBS" = "/var/lib/spectre/tools/c2/libs" ] \
   || [ "$GUARD_GEN" = "/var/lib/spectre/tools/c2/generators" ]; then
  if [ "${SPECTRE_ALLOW_DEFAULT_DATA:-0}" != "1" ]; then
    echo "[fetch-jars] 拒绝: 目标为生产缺省路径(解析 $GUARD_LIBS / $GUARD_GEN)——设 SPECTRE_DATA_DIR=<隔离目录> 或显式 SPECTRE_ALLOW_DEFAULT_DATA=1" >&2
    exit 1
  fi
  echo "[fetch-jars] 警告: SPECTRE_ALLOW_DEFAULT_DATA=1 —— 写入生产路径 $ROOT" >&2
fi
LIBS=${LIBS_DIR:-$ROOT/tools/c2/libs}
GEN=${GEN_DIR:-$ROOT/tools/c2/generators}
mkdir -p "$LIBS" "$GEN"
FAILED=()
# R32D59 观测项: sha256 清单——首跑落账, 重跑校验(防篡改/半下载静默
# 留存; HTTP 200 不等于内容完整)。清单恒在 c2 根, 增量维护。
MANIFEST="${LIBS%/*}/.sha256"  # R32D69-F3: 置 c2 根+条目相对路径——cd c2 根 sha256sum -c 可用
# CS48-4/CS50-N2: 升级迁移——旧清单(libs/.sha256, 条目=裸文件名,
# git 全史三代同口径)一次性转译为 c2 根相对制, 存量部署
# 不再静默全量重下 ~51MB; 迁移后旧清单删除。
OLD_MANIFEST="$LIBS/.sha256"
if [ -f "$OLD_MANIFEST" ] && [ ! -f "$MANIFEST" ]; then
  # CS49-F2: 真实旧清单=裸文件名(git 全史三代写入口径同)——spring-*
  # 入 libs/spring/, jmg-* 入 generators/, 其余入 libs/。此前 awk 假设
  # ./x|spring/x 前缀从未存在, 迁移后 15 条错 10 条(-c 10 FAILED)。
  awk '{
    p = $2
    if (p ~ /^\.\//) sub(/^\.\//, "", p)
    if (p ~ /^generators\//) out = p
    else if (p ~ /^spring\//) out = "libs/" p
    else if (p ~ /^jmg-/) out = "generators/" p
    else if (p ~ /^spring-/) out = "libs/spring/" p
    else out = "libs/" p
    print $1 "  " out
  }' "$OLD_MANIFEST" > "$MANIFEST" && rm -f "$OLD_MANIFEST"
fi
fetch() { # fetch <目录> <完整URL> <文件名>
  local dir=$1 url=$2 name=$3
  # R32D69-F3: 清单条目=相对 c2 根路径(cd c2 根 sha256sum -c 可用)。
  # 调用方两形态: LIBS 相对段("." / "spring"——cwd 已在 LIBS)与 GEN 绝对。
  local rel
  case "$dir" in
    /*) rel="generators/$name" ;;
    .)  rel="libs/$name" ;;
    *)  rel="libs/$dir/$name" ;;
  esac
  # R32D59 观测项/CS37: sha256 清单(awk 精确匹配文件名列, 免正则元字符错配);
  # 清单恒在 c2 根(GEN/spring jar 同账, 相对路径)。
  if [ -f "$dir/$name" ] && [ -f "$MANIFEST" ]; then
    want=$(awk -v n="$rel" '$2==n{print $1}' "$MANIFEST")
    if [ -n "$want" ]; then
      got=$(sha256sum "$dir/$name" | awk '{print $1}')
      if [ "$want" != "$got" ]; then
        echo "  ✗ $name sha256 不符(清单 $want 实际 $got)——删除重取"; rm -f "$dir/$name"
      fi
    fi
    [ -f "$dir/$name" ] && return 0
  fi
  if curl -fsSL --retry 2 -o "$dir/$name" "$url"; then
    got=$(sha256sum "$dir/$name" | awk '{print $1}')
    want=$(awk -v n="$rel" '$2==n{print $1}' "$MANIFEST" 2>/dev/null)
    if [ -n "$want" ]; then
      if [ "$want" != "$got" ]; then
        echo "  ✗ $name 新下载 sha256 与清单不符($want≠$got)"; rm -f "$dir/$name"; FAILED+=("$name"); return 1
      fi
    else
      mkdir -p "$LIBS"; echo "$got  $rel" >> "$MANIFEST"
    fi
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
# CS26-6: asm-commons 已删——下载后全仓零引用(CpSplitter 仅 import org.objectweb.asm.*)
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
