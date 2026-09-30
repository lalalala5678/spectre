---\nname: taint-audit\ndescription: 污点链审计(阶段三·核心)\n---\n\n# 污点链审计(阶段三·核心)
[read-only] source→传播→sink 全链证明,过滤绕过是主战场。

## 双引擎
1. semgrep 批扫: `semgrep --config /opt/tools/semgrep-rules/java/lang/security --config /opt/tools/semgrep-rules/php/lang/security --json <src> -o /tmp/sg.json`
   重点规则族: java/lang/security/audit/(sql-injection command-injection
   deserialization ssrf path-traversal)+php 同族
2. 手工回溯(ripgrep): sink 候选→向上追调用链到 controller 入口
   `rg -n "orderByColumn|createTable|queryFieldBySql" --type java`

## 高危 sink 速查(MyBatis 系)
- `${}` 拼接: `rg -n '\$\{' --type xml -g '*Mapper.xml'`(vs #{} 安全位)
- createTable/alterTable/execute(sql 直传)
- JDBC URL 直传: DriverManager.getConnection(参数化 URL)——H2 INIT=RUNSCRIPT=RCE
- 表达式引擎: SPIEL/Groovy(freemarker/velocity/OGNL/Q LExpress
- 命令: Runtime.exec/ProcessBuilder;反序列化: ObjectInputStream/
  readObject/Jackson enableDefaultTyping/Shiro rememberMe
- 文件: new File(参数)/FileUtils/transferTo(MultipartFile 原名直用)

## 过滤函数完整性判定(绕过=洞的核心)
黑名单类(SqlUtil.filterKeyword/SqlInjectionUtil): 逐条审正则——
注释符变体(/*+ /\*/内联注释)、编码(%00 截断/URL 双编码)、嵌套
(selselectect)、等价函数(extractvalue/updatexml)、大小写/空白插入。
白名单类(后缀): 双写(.php.jpg 解析)/空字节/后缀大小写/类型头伪造。
**过滤函数引用代码行证明不完整才算数。**

## diff 审计(0.5day 高效路径)
git log tagA..tagB 找含 fix/安全/cve 关键词的 commit→diff 反推漏洞点→
向下检查目标版本是否仍含等价缺陷(修复不彻底=变体=你的 0day)。

## 平台工具+族速查(2026-09 benchmark 固化)
- `wb-mapper-dollar.sh <srcdir>`:Mapper ${} 全扫(带 mapper id)
- `wb-tagdiff.sh <owner/repo> <tagA> <tagB>`:双 tag diff 补丁定位(安全文件优先
  词表 Sql/Aspect/Interceptor/Filter/Security/Shiro/Auth/Upload/Download/Util,
  补丁行自动提取)——tagdiff 优先于全文审计(0.5day 最高产,827/830 直接命中)
- `wb-blacklist-bench.sh '<regex>'`:黑名单完整性预演(规范向量语料,可独立判定
  漏杀,无需等补丁 diff 证实)
- `wb-jar-audit.sh <groupId> <artifactId> <ver>`:壳仓库→repo1.maven 拉 jar→
  CFR 反编译→高危面预扫(JeecgBoot 3.5.3 内嵌 jimureport 1.5.9≠仓库版本陷阱)
- jmreport 族高发面:/jmreport/queryFieldBySql(SSTI≤1.6.0)/loadTableData(任意
  SQL)/testConnection(任意 JDBC,firewall 默认 null)/upload(黑名单 jsp/php/html
  contains 方向漏杀 jsx/svg;签名密钥 DEFAULT_SECRET=<demo应用默认密钥>
  硬编码可伪造);三层鉴权模型:宿主 anon×签名拦截器(safeMode=false 时恒过)×
  token 拦截器(无自定义 verifyToken 恒 true)
- RuoYi 族状态:createTable SQLi≤4.7.9(4.8.0 补 sleep/union/like//**/\u000B);
  genCode 任意写≤4.7.9(4.8.0 allowOverwrite);download/resource 面已防住(反证
  台账,勿重审);dataScope 已修

## 收尾纪律(二轮实证)
- semgrep 基线=阶段三**收尾卫生扫**(必跑):856 号洞正是 308 hits 判读后唯一漏网
  真鱼——手工聚焦后基线兜底,两层缺一不可
- `replace("..","")` 删除型过滤判别:纯删除无重组向量=防住;结合 getBaseDir/黑名单
  才能定论;substring/indexOf 定位型同理逐行判
- 完美口径=工具/方法论/纪律完备+残留台账明确(每项含可达性判断);审计深度
  受时间盒约束,台账里的残留不是缺陷,没有台账才是
