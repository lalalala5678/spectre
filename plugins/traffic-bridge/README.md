# SPECTRE Traffic Bridge(Chrome 扩展)

把浏览器里的**认证态流量对**送进 SPECTRE 情报库——MFA/SSO 后面的业务
系统 agent 自己登不进去, 人能登进去: 人浏览, 扩展抓流量, 席位
(api/exploit)经 `query_intel kind=intel q=[流量]` 消费。

## 安装

1. 生成网关 API Key(会话 cookie 是 SameSite=Strict, 跨站扩展带不上——
   API Key 通道即为此设):

   ```bash
   sudo SPECTRE_AUTH_DIR=/etc/spectre-auth python3 gateway/spectre-apikey.py add traffic-bridge
   # 打印 sk-… (只显示一次)
   ```

2. Chrome/Edge → `chrome://extensions/` → 开发者模式 → **加载已解压的扩
   展程序** → 选本目录(`plugins/traffic-bridge/`)。

3. 点扩展图标: 填网关地址(如 `https://spectre.example.com`)+ API Key
   → **测试连通**(✓ 即密钥与链路双通)→ 保存。

## 使用

1. 正常登录目标系统, 操作要测的流程(F12 保持打开)。
2. F12 → **SPECTRE** 面板: 刷新 HAR → 过滤/勾选流量对(≤50/批, 单体
   64KB 截断)→ 可选批次标题 → **送入 SPECTRE**。
3. 回执显示入库 seq; 席位侧:

   ```
   query_intel(kind=intel, q=[流量])
   ```

   流量对以 intel-note 落库(`from: operator`), 归属当前活跃项目
   (`workSessionId` 继承; 提交体可显式覆盖)。

## 协议(非浏览器客户端同用)

```
POST {gateway}/spectre/api/traffic
X-Spectre-Key: sk-…
{ "title"?: string,
  "workSessionId"?: string,
  "pairs": [ { "request": { "method", "url", "headers"?, "body"? },
               "response": { "status"?, "headers"?, "body"? },
               "note"? } ] }   // ≤50 对/批
→ 200 { ok, filed, seqs[], workSessionId, note? }
```

错误密钥 401 JSON; 形状违规 400 带指引文案。 Burp 插件可走同一端点。
