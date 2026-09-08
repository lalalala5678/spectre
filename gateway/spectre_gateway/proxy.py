"""Reverse proxy for /spectre/api/* → loopback agent runtime.

Streams upstream bodies chunk-by-chunk so SSE connections pass through
unbuffered. Only reached after the handler authenticated the session.
"""

import http.client

from . import config


class ProxyError(Exception):
    """Upstream connection failure."""

    def __init__(self, status=502, message="backend unavailable"):
        super().__init__(message)
        self.status = status


def proxy(handler, api_path):
    """Forward the current request to the runtime; stream the response back.

    `api_path` is the runtime-relative path (PREFIX already stripped).
    """
    length = int(handler.headers.get("Content-Length") or 0)
    body = handler.rfile.read(length) if length else None

    upstream = http.client.HTTPConnection(
        config.RUNTIME_HOST, config.RUNTIME_PORT, timeout=600,
    )
    try:
        upstream.request(handler.command, api_path, body=body, headers={
            "Content-Type": handler.headers.get("Content-Type", ""),
            "Accept": handler.headers.get("Accept", ""),
        })
        response = upstream.getresponse()
    except (OSError, http.client.HTTPException) as error:
        upstream.close()
        raise ProxyError(message=str(error)) from error

    handler.send_response(response.status)
    skip = {"content-length", "transfer-encoding", "connection", "keep-alive"}
    for name, value in response.getheaders():
        if name.lower() not in skip:
            handler.send_header(name, value)
    handler.send_header("Transfer-Encoding", "chunked")
    handler.end_headers()

    try:
        while True:
            # read1: return whatever the current chunk holds instead of
            # buffering until `amt` bytes arrive — essential for SSE frames.
            chunk = response.read1(4096)
            if not chunk:
                break
            handler.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
            handler.wfile.flush()
        handler.wfile.write(b"0\r\n\r\n")
    except (BrokenPipeError, ConnectionResetError):
        pass  # client went away mid-stream (normal for SSE)
    finally:
        upstream.close()
