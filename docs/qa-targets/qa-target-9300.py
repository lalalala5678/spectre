#!/usr/bin/env python3
"""QA 靶: 9300(指纹面+actuator)——容器重建持久版"""
from http.server import HTTPServer, BaseHTTPRequestHandler
class V(BaseHTTPRequestHandler):
    def do_GET(self):
        if "/actuator/health" in self.path:
            body = b'{"status":"UP","db":{"status":"UP"},"redis":{"status":"UP"}}'
        elif self.path == "/":
            body = b"<html><title>Welcome to nginx!</title></html>"
        else:
            body = b"404"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("X-Powered-By", "PHP/7.2.34")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", 9300), V).serve_forever()
