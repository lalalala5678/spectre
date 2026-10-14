import socket, threading, datetime
def log(s):
    with open('listener.log','a') as f:
        f.write(f"{datetime.datetime.utcnow().isoformat()}Z {s}\n")
srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('0.0.0.0', 19998))
srv.listen(16)
log('LISTENING 0.0.0.0:19998')
while True:
    c, a = srv.accept()
    try:
        c.settimeout(2)
        data = c.recv(2048)
        log(f"CONN from {a} data={data[:200]!r}")
        try:
            c.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nPROOF!!')
        except Exception:
            pass
    except Exception as e:
        log(f"ERR {e}")
    finally:
        c.close()
