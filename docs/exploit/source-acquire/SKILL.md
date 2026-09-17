---\nname: source-acquire\ndescription: 源码获取(阶段一)\n---\n\n# 源码获取(阶段一)
[read-only 下载] 版本精确对齐是审计有效性的前提。

## 获取路径(按命中率)
1. GitHub tag tarball: `curl -L https://codeload.github.com/<owner>/<repo>/tar.gz/refs/tags/v<X.Y.Z>` (API 403 时直接 codeload,绕限流)
2. gitee 镜像(国内项目若依/jeecg 均有): `https://gitee.com/mirrors_*` 或官方 gitee 仓
3. release 附件(zip 含依赖更全)
4. 浅克隆: `git clone --depth 1 --branch v4.7.9 <url>`(需要 diff 审计时 --depth 50 留历史)

## 版本对齐
- tag 列表核对: `git ls-remote --tags <url>`;拿不到精确版→最近 tag+声明差异(如 4.7.9 指纹→4.7.8 tag,声明"差一版,结论需复核该区间 diff")
- 快照指纹: pom.xml/wrapper 版本号、package.json version 字段与指纹互证
- 国产项目双仓(github/gitee)内容可能不同步,以目标指纹特征(favicon/静态资源 hash)辅助判断

## 依赖与编译面
- Java: pom.xml 依赖表=攻击面清单(shiro/fastjson/xxl-job/h2 版本→已知 CVE 排查转 nday)
- PHP: composer.lock 精确版本
- 不编译也能审:静态读码为主,semgrep 不需要构建

## 版本对齐陷阱(2026-09 实战)
- 壳仓库:JeecgBoot 主仓是 example/db 壳,真代码在内嵌 starter jar(pom 查内嵌
  版本,3.5.3→jimureport 1.5.9)→wb-jar-audit.sh 反编译链
- 上报前必读所有 application*.yml(dev/prod profile 差异:dev=local/prod=alioss
  会影响 upload 洞成立性——seq849 被驳教训)
