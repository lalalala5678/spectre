---
name: spectre-nuclei
description: nuclei 模板引擎——直接执行社区 14000+ 漏洞模板(YAML)
---

# spectre-nuclei(nuclei 借鉴)
[read-only scan] 模板在 /opt/tools/nuclei-templates(社区库,14000+)。

## 用法
```bash
# 按关键词筛模板
spectre-nuclei.py list --templates /opt/tools/nuclei-templates --search weblogic
# 按 CVE 编号
spectre-nuclei.py list --templates /opt/tools/nuclei-templates --search CVE-2024
# 执行(单模板)
spectre-nuclei.py run --target http://x.com --template /opt/tools/nuclei-templates/http/cves/xxx.yaml
# 批量(目录+严重性过滤)
spectre-nuclei.py run --target http://x.com --templates /opt/tools/nuclei-templates/http/exposures --severity critical,high --output /tmp/findings.json
```

## 输出
- 终端:🔴critical/🟠high/🟡medium/🔵low 图标+模板名+匹配 URL
- JSON(--output):含 curl 复现命令+提取的动态值(extractor)

## 支持的模板特性
- requests[http]: method/path(list)/headers/body/matchers(word,regex,status,negative)/extractors(regex,kval)
- dns 协议: A/CNAME 查询(word matcher)
- 变量: {{BaseURL}}/{{RootURL}}/{{Host}}
- 跳过: interactsh OOB 模板(无 OOB 基础设施)

## 工作流
指纹识别(recon)→按指纹筛模板(--search <框架名>)→执行→findings JSON 落 /tmp→report
