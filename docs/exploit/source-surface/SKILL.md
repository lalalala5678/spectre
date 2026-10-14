---
name: source-surface
description: 白盒审计前置: 获取目标版本源码并测绘攻击面(源码已在工作区则跳过获取, 直接进入未鉴权金矿/拦截器白名单/路由枚举)
---

# 白盒审计前置: 源码获取 → 攻击面测绘

**源码已在工作区则跳过阶段一, 直接进入阶段二。**

## 阶段一·源码获取

[read-only 下载] 版本精确对齐是审计有效性的前提。

### 获取路径(按命中率)
1. GitHub tag tarball: `curl -L https://codeload.github.com/<owner>/<repo>/tar.gz/refs/tags/v<X.Y.Z>` (API 403 时直接 codeload,绕限流)
2. gitee 镜像(国内项目若依/jeecg 均有): `https://gitee.com/mirrors_*` 或官方 gitee 仓
3. release 附件(zip 含依赖更全)
4. 浅克隆: `git clone --depth 1 --branch v4.7.9 <url>`(需要 diff 审计时 --depth 50 留历史)

### 版本对齐
- tag 列表核对: `git ls-remote --tags <url>`;拿不到精确版→最近 tag+声明差异(如 4.7.9 指纹→4.7.8 tag,声明"差一版,结论需复核该区间 diff")
- 快照指纹: pom.xml/wrapper 版本号、package.json version 字段与指纹互证
- 国产项目双仓(github/gitee)内容可能不同步,以目标指纹特征(favicon/静态资源 hash)辅助判断

### 依赖与编译面
- Java: pom.xml 依赖表=攻击面清单(shiro/fastjson/xxl-job/h2 版本→已知 CVE 排查转 nday)
- PHP: composer.lock 精确版本
- 不编译也能审:静态读码为主,semgrep 不需要构建

### 版本对齐陷阱(2026-09 实战)
- 壳仓库:JeecgBoot 主仓是 example/db 壳,真代码在内嵌 starter jar(pom 查内嵌
  版本,3.5.3→jimureport 1.5.9)→wb-jar-audit.sh 反编译链
- 上报前必读所有 application*.yml(dev/prod profile 差异:dev=local/prod=alioss
  会影响 upload 洞成立性——seq849 被驳教训)

## 阶段二·攻击面测绘

[read-only] 路由注册面全枚举——审计优先级排序器。

### Spring 系(若依/JeecgBoot 族)
1. 路由注解全扫: `grep -rn "@RequestMapping\|@GetMapping\|@PostMapping" --include="*.java" | wc -l`
2. **未鉴权金矿三处**:
   - SecurityConfig/ShiroConfig 的 filterChainDefinitionMap putAnon / permitAll 列表
   - @Anonymous / @PassToken / @IgnoreAuth 类自定义注解(grep 定义处,再全扫使用处)
   - 拦截器白名单: ExcludeUrlProperties/ignore-urls 配置项(application.yml)
3. jeecg 特有: JimuNoLoginRequired 注解、/jmreport/** 拦截器豁免(历史洞高发区)
4. 低权可达: @RequiresPermissions 值 vs 默认角色权限表(sys_menu 初始 SQL)

### ThinkPHP/PHP 系
- route 配置(route.php)+控制器自动映射+__call 魔术方法面
- 中间件白名单(middleware.php allow)

### 产出表
| 端点 | 鉴权 | 控制器.方法 | 参数 | 优先级 |
未鉴权×功能端点=P0;未鉴权×静态资源=P2;低权×管理功能=P1。
该表直接决定阶段三的审计顺序——不要均匀撒网。

### 平台工具(2026-09 白盒 benchmark 5 工具沉淀)
- `wb-anon.sh <srcdir>`:5 框架未鉴权面一发提取(Shiro anon/Security permitAll/
  @SaIgnore/yml excludes/拦截器注册)——jeecg 实测一发命中 /jmreport/** anon
- 工具位:/opt/tools/bin/wb-*.sh
- sa-token 陷阱:拦截器 excludes 上的路径 @SaCheckPermission 同步失效(ruoyi-ai
  839 根因);拦截器注册函数的覆盖表=豁免金矿

### 路径匹配三写法判例集(SOP v3,2026-09 /chat 误判教训)
`excludePathPatterns`/anon 链的豁免判定=匹配模式语义×端点实际路径双核对:
- `/path`(精确)≠`/path/**`(Ant 递归)≠前缀想当然
- 判例:seq839 `/resource/oss/upload` 精确端点=成立;seq833 `/jmreport/**`
  递归=成立;/chat(把精确当递归用)=误判被 writer 实证驳回
- 判豁免面前置步骤:先抄下注册代码原文的写法,再逐端点核对

### 运营侧效率指标(白盒 benchmark 标定)
- 重发现率:精确/同族/反证/误报 四分(首轮 5/2/1/0);产出密度:洞/小时(首轮 11 洞/3h≈3.7)
- tagdiff 命中占比:补丁定位法直接命中的洞占比(827/830=2/11)
- SOP 版本追踪:每轮自评后 SOP+1,趋势回退=技能债
