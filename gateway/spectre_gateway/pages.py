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
  h1 { font-size: 20px; font-weight: 600; color: var(--text-primary); }
  .sub { font-size: 13px; color: var(--text-tertiary); margin: 6px 0 28px; }
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
  }
  button:hover { background: var(--accent-hover); }
  .err { margin-top: 14px; font-size: 13px; color: var(--danger);
    text-align: center; min-height: 16px; }
  .foot { margin-top: 20px; font-size: 12px; color: var(--text-tertiary);
    text-align: center; }
</style>
</head>
<body>
  <form class="card" method="POST" action="__ACTION__" autocomplete="off">
    <h1>SPECTRE</h1>
    <div class="sub">多智能体渗透测试平台</div>
    <label for="user">账号</label>
    <input id="user" name="user" type="text" required autofocus
      autocomplete="username">
    <label for="pw">口令</label>
    <input id="pw" name="pw" type="password" required
      autocomplete="current-password">
    <button type="submit">登录</button>
    <div class="err">__MSG__</div>
    <div class="foot">仅用于授权的安全测试作业</div>
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
