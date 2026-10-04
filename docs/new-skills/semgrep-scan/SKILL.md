---
name: semgrep-scan
description: semgrep 规则引擎——3000+ 社区规则白盒扫描
---

# semgrep(semgrep 借鉴)
[read-only] semgrep——若 /opt/tools/py/semgrep 缺失, 先装:pip install --target /opt/tools/py semgrep(装后经 /opt/tools/py 可用);沙箱容器内同路径

## 用法
```bash
export PYTHONPATH=/opt/tools/py/semgrep:/opt/tools/py
# 社区规则(联网)或本地规则
/opt/tools/py/semgrep/bin/semgrep --config auto /path/to/src     # 自动选规则
/opt/tools/py/semgrep/bin/semgrep --config /path/rule.yaml file  # 自定义规则
# taint 模式(污点追踪: source→sink)
semgrep --config taint-rule.yaml --config-termine-mode taint src/
```

## 自定义规则(快速上手)
```yaml
rules:
  - id: sql-concat-taint
    mode: taint
    pattern-sources: [{pattern: request.args[...]}]
    pattern-sinks: [{pattern: cursor.execute(...)}]
    message: SQL 注入(污点直达)
    severity: ERROR
    languages: [python]
```

## 与 LLM 协作模式
1. semgrep 扫全量(快,规则准)
2. LLM 只分析 findings 的上下文(判断可利用性)——不逐行读代码
3. 结论:可达性分析(参数是否外部可控→是否有鉴权→是否可稳定触发)
