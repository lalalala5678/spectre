"""Login page template (self-contained HTML, no external assets)."""

from . import config

_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>SPECTRE · 登录</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0d12; color: #a1a1aa;
    min-height: 100vh; display: flex;
    align-items: center; justify-content: center;
  }
  .card {
    width: 340px; padding: 28px 26px;
    background: #10131b; border: 1px solid #272b38; border-radius: 6px;
  }
  h1 { font-size: 15px; letter-spacing: 4px; color: #e4e4e7; }
  .sub { font-size: 10px; color: #52525b;
    margin: 4px 0 22px; letter-spacing: 1px; }
  label { display: block; font-size: 10px;
    text-transform: uppercase; letter-spacing: 1.5px;
    color: #52525b; margin: 14px 0 5px; }
  input {
    width: 100%; padding: 8px 10px; font: inherit; font-size: 13px;
    background: #0b0d12; border: 1px solid #272b38;
    border-radius: 3px; color: #e4e4e7;
    outline: none; letter-spacing: 1px;
  }
  input:focus { border-color: #ea580c; }
  button {
    width: 100%; margin-top: 22px; padding: 9px;
    font: inherit; font-size: 12px;
    letter-spacing: 3px; background: #ea580c; color: #fff; border: 0;
    border-radius: 3px; cursor: pointer;
  }
  button:hover { background: #f97316; }
  .err { margin-top: 14px; font-size: 11px; color: #ef4444;
    text-align: center; min-height: 14px; }
  .foot { margin-top: 18px; font-size: 9px; color: #3f3f46;
    text-align: center; letter-spacing: 1px; }
</style>
</head>
<body>
  <form class="card" method="POST" action="__ACTION__" autocomplete="off">
    <h1>SPECTRE</h1>
    <div class="sub">SPECTRE · AGENT CONSOLE — RESTRICTED</div>
    <label for="user">Operator</label>
    <input id="user" name="user" type="text" required autofocus
      autocomplete="username">
    <label for="pw">Passphrase</label>
    <input id="pw" name="pw" type="password" required
      autocomplete="current-password">
    <button type="submit">AUTHENTICATE</button>
    <div class="err">__MSG__</div>
    <div class="foot">authorized pentest operations only
      · all access is audited</div>
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
