"""Login page template (self-contained HTML, no external assets).

与控制台混合主题对齐: 深色壳+浅色内容面单套——登录卡为浅色面、13px 标签、Indigo 主按钮(#4f46e5 白字 6.29:1)、
文案去黑客风(账号/口令/登录)。自包含无外链, 网关无静态依赖面不变。
"""

from . import config

_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>SPECTRE · 登录</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f8f9fb; --surface: #ffffff; --line: #e2e5ea;
    --text-primary: #1a1f28; --text-secondary: #4b5563;
    --text-tertiary: #616b7a; --line-strong: #8b95a5;
    --accent: #4f46e5; --accent-hover: #4338ca;
    --danger: #b91c1c;
    --shadow: 0 1px 3px rgb(16 24 40 / 0.10), 0 1px 2px rgb(16 24 40 / 0.06);
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI',
      'PingFang SC', 'HarmonyOS Sans SC', 'MiSans', 'Noto Sans SC',
      'Microsoft YaHei', sans-serif;
    background: var(--bg); color: var(--text-secondary);
    min-height: 100vh; display: flex;
    align-items: center; justify-content: center;
  }
  .card {
    width: 360px; padding: 32px 28px;
    background: var(--surface); border: 1px solid var(--line-strong);
    border-radius: 8px; box-shadow: var(--shadow);
  }
  .brand { display: flex; flex-direction: column; align-items: center;
    gap: 8px; margin-bottom: 26px; }
  .brand svg { display: block; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: 0.01em;
    color: var(--text-primary); }
  .sub { font-size: 13px; color: var(--text-tertiary); margin: 0 0 26px; }
  label { display: block; font-size: 13px; font-weight: 500;
    color: var(--text-secondary); margin: 16px 0 6px; }
  input {
    width: 100%; padding: 8px 10px; font: inherit; font-size: 14px;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: 6px; color: var(--text-primary); outline: none;
  }
  input:focus { border-color: var(--accent);
    box-shadow: 0 0 0 2px rgb(79 70 229 / 0.25); }
  button {
    width: 100%; margin-top: 24px; padding: 9px;
    font: inherit; font-size: 14px; font-weight: 500;
    background: var(--accent); color: #fff; border: 0;
    border-radius: 6px; cursor: pointer;
    transition: background-color 120ms ease;
  }
  button:hover { background: var(--accent-hover); }
  button:active { transform: translateY(1px); }
  @media (prefers-reduced-motion: reduce) {
    button { transition: none; }
  }
  .err { margin-top: 14px; font-size: 13px; color: var(--danger);
    text-align: center; min-height: 16px; }
  .foot { margin-top: 20px; font-size: 12px; color: var(--text-tertiary);
    text-align: center; }
</style>
</head>
<body>
  <form class="card" method="POST" action="__ACTION__" autocomplete="off">
    <div class="brand">
      <svg viewBox="0 0 32 32" width="44" height="44"
        role="img" aria-label="SPECTRE">
        <path d="M16 2.2 L28.3 9.3 V22.7 L16 29.8 L3.7 22.7 V9.3 Z"
          fill="#f1f3f5" stroke="#8b95a5" stroke-width="1"/>
        <g stroke="#616b7a" stroke-width="0.8" opacity="0.7">
          <line x1="16" y1="5.5" x2="25.09" y2="10.75"/>
          <line x1="25.09" y1="10.75" x2="25.09" y2="21.25"/>
          <line x1="25.09" y1="21.25" x2="16" y2="26.5"/>
          <line x1="16" y1="26.5" x2="6.91" y2="21.25"/>
          <line x1="6.91" y1="21.25" x2="6.91" y2="10.75"/>
          <line x1="6.91" y1="10.75" x2="16" y2="5.5"/>
        </g>
        <g stroke="#b91c1c" stroke-width="1.1">
          <line x1="16" y1="8.6" x2="16" y2="11.4"/>
          <line x1="16" y1="20.6" x2="16" y2="23.4"/>
          <line x1="8.6" y1="16" x2="11.4" y2="16"/>
          <line x1="20.6" y1="16" x2="23.4" y2="16"/>
        </g>
        <circle cx="16" cy="16" r="4.6" fill="none"
          stroke="#b91c1c" stroke-width="1.1"/>
        <circle cx="16" cy="16" r="1.6" fill="#b91c1c"/>
        <g stroke="#f1f3f5" stroke-width="0.6">
          <circle cx="16" cy="5.5" r="2" fill="#4f46e5"/>
          <circle cx="25.09" cy="10.75" r="1.5" fill="#4b5563"/>
          <circle cx="25.09" cy="21.25" r="1.5" fill="#4b5563"/>
          <circle cx="16" cy="26.5" r="1.5" fill="#4b5563"/>
          <circle cx="6.91" cy="21.25" r="1.5" fill="#4b5563"/>
          <circle cx="6.91" cy="10.75" r="1.5" fill="#4b5563"/>
        </g>
      </svg>
      <h1>SPECTRE</h1>
      <div class="sub">多智能体渗透测试平台</div>
    </div>
    <label for="user">账号</label>
    <input id="user" name="user" type="text" required autofocus
      autocomplete="username">
    <label for="pw">口令</label>
    <input id="pw" name="pw" type="password" required
      autocomplete="current-password">
    <button type="submit">登录</button>
    <div class="err">__MSG__</div>
  </form>
</body>
</html>
"""

_ERROR_MESSAGES = {
    "cred": "用户名或密码错误",
    "lock": "尝试次数过多，已锁定 15 分钟",
}


def render_login(message_key=""):
    """Return the login page HTML with the error message filled in."""
    return _TEMPLATE.replace(
        "__ACTION__", config.PREFIX + "/login",
    ).replace("__MSG__", _ERROR_MESSAGES.get(message_key, ""))
