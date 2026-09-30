#!/usr/bin/env python3
"""QA 靶: 9901(API+openapi)——容器重建持久版"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json
class API(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/openapi.json':
            b = json.dumps({'openapi':'3.0','security':[{'bearer':[]}],'paths':{'/api/users/{id}':{'get':{'summary':'Get user','parameters':[{'name':'id','in':'path','required':True}]}},'/api/debug/config':{'get':{'summary':'debug','security':[]}}}}).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
        else:
            self.send_response(200); self.send_header('Content-Length','2'); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self,*a): pass
HTTPServer(("127.0.0.1", 9901), API).serve_forever()
