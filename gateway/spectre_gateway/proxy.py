"""Reverse proxy for /spectre/api/* → loopback agent runtime.

Streams upstream bodies chunk-by-chunk so SSE connections pass through
unbuffered. Only reached after the handler authenticated the session.
"""

import http.client

from . import config


class ProxyError(Exception):
    """Upstream connection failure."""

    def __init__(self, status=502, message="后端 runtime 不可达"):
        super().__init__(message)
        self.status = status


def normalize_content_length(raw):
    """Parse Content-Length safely (CS4-M3/CS5-N3).

    非数 → 0; 负值 → 0(read(-n) 是"读到 EOF"的阻塞语义); 其余原值。
    """
    try:
        length = int(raw or 0)
    except ValueError:
        return 0
    return length if length > 0 else 0


def proxy(handler, api_path):
    """Forward the current request to the runtime; stream the response back.

    `api_path` is the runtime-relative path (PREFIX already stripped).
    """
    # CS4-M3/CS5-N3: 非数与负值的归一化单源 normalize_content_length
    length = normalize_content_length(handler.headers.get("Content-Length"))
    body = handler.rfile.read(length) if length else None

    upstream = http.client.HTTPConnection(
        config.RUNTIME_HOST, config.RUNTIME_PORT, timeout=600,
    )
    try:
        headers = {
            "Content-Type": handler.headers.get("Content-Type", ""),
            "Accept": handler.headers.get("Accept", ""),
            # the runtime enforces the internal token on EVERY /api route;
            # inject it here on behalf of the authenticated console session
            "X-Internal-Token": config.RUNTIME_TOKEN,
            # F75/R1-F1: 服务端来源标记(上游头集合为固定构造, 客户端
            # 不可伪造)——runtime 的 internal-only 子门以此区分
            # '经网关的控制台会话' 与 'Temporal/内部直连'。
            "X-Console-Origin": "1",
        }
        if handler.command == "HEAD":
            body = None
        upstream.request(handler.command, api_path, body=body, headers=headers)
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
    except (BrokenPipeError, ConnectionResetError, TimeoutError):
        pass  # client went away mid-stream (normal for SSE)
    except (ValueError, http.client.IncompleteRead, ConnectionError):
        # R32D32-R1/R32D33-N3: upstream died mid-chunk (runtime restart)
        # surfaces as a torn chunk header (int('') ValueError), a short
        # chunk body (IncompleteRead) or a reset (ConnectionError). The
        # stream is unrecoverable; end the chunked body cleanly so the
        # browser reconnects its SSE instead of spraying tracebacks.
        try:
            handler.wfile.write(b"0\r\n\r\n")
            handler.wfile.flush()
        except OSError:
            pass
    finally:
        upstream.close()
