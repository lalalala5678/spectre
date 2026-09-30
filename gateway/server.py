#!/usr/bin/env python3
"""SPECTRE auth gateway entrypoint (systemd target)."""

from spectre_gateway.handler import serve
from spectre_gateway import config
import os as _os
if not config.RUNTIME_TOKEN:
    raise SystemExit(
        "[gateway] FATAL: INTERNAL_TOKEN 未设置——所有 /api 反代将被 runtime 拒绝(401)。\n"
        "          设 INTERNAL_TOKEN=<与 backend/.env 同值> 后重启")
if not _os.path.isdir(config.DIST_DIR) or not _os.path.exists(_os.path.join(config.DIST_DIR, "index.html")):
    print(f"[gateway] 警告: DIST_DIR={config.DIST_DIR} 无 index.html —"
          f" 前端未构建或路径错误(console: npm run build; 或设 GATEWAY_DIST_DIR)", flush=True)

if __name__ == "__main__":
    serve()
