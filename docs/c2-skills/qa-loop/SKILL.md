---
name: qa-loop
description: 面杀 Q&A 循环——引擎适配·迭代·交付
---

# 面杀 Q&A(线三,/opt/tools/bin/c2-qa.py)
[uploads samples] 引擎集=scope.json 配置;私架优先,公网最小化。

## 引擎适配器
- 本地(无 key):clamav(clamscan/clamdscan)/yara(自建规则集)
- 微步云沙箱:API key 必需(注册 x.threatbook.com,云端报告含引擎矩阵)
- VirusTotal:key 必需(免费 public API 4 req/min·500/day,仅当需要
  国际面参考;注意样本公开性——先问私架能否等效)
- 私架端点:HTTP POST 约定(自定义 header 鉴权)
## 循环协议
功能自测→提交引擎集→全过=交付;任一报=特征名反查变换族→变体→重测;
8 轮上限;未全过=最佳变体+残留明细+建议(如实)。
## 交付包
载荷+指纹+引擎结果矩阵+审计行(目标/哈希/时间)+一次性使用说明。

## 引擎 API 调研结论(2026-09,answer: 哪些要 key)
| 引擎 | key | 说明 |
|---|---|---|
| clamav/yara 本地 | **不需要** | 零依赖离线,冒烟/QA 首选(注意 yara 规则用文件路径,目录作规则源会静默失败) |
| 私架沙箱端点 | 不需要(自定义鉴权) | HTTP POST 约定,样本不外流,首选真验证 |
| 微步云沙箱 x.threatbook.com | **必须** | 注册申请 API key;云沙箱报告含国产引擎矩阵,护网相关度最高;按次配额 |
| VirusTotal | **必须** | 免费 public API:4 req/min·500 次/天;注意样本公开性(厂商消费 VT 源=烧样本),仅在需国际面参考且私架无法等效时用 |
- 接入顺序:本地→私架→微步→VT(每级先问"样本外流风险是否必要")
- key 注入:环境变量 THREATBOOK_API_KEY / VT_API_KEY(适配器已预留位)
