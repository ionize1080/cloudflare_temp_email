"""Private bounded object storage for IONACS Mail, behind Cloudflare Tunnel."""
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socketserver
import tempfile
import threading

ROOT = Path(os.environ.get('MAIL_STORAGE_DIR', '/var/lib/ionacs-mail-storage'))
SECRET = Path(os.environ.get('CREDENTIALS_DIRECTORY', '/etc/ionacs-mail-storage')) / 'token'
MAX_FILE = 25 * 1024 * 1024
MAX_TOTAL = 10 * 1024**3
LOCK = threading.Lock()
SLOTS = threading.BoundedSemaphore(4)

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'IONACS Storage'
    def setup(self):
        super().setup()
        self.connection.settimeout(45)
    def log_message(self, *_):
        pass
    def reply(self, status, data=b''):
        self.send_response(status)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)
    def authorized(self):
        expected = 'Bearer ' + SECRET.read_text().strip()
        if not hmac.compare_digest(hashlib.sha256(self.headers.get('Authorization','').encode()).digest(), hashlib.sha256(expected.encode()).digest()):
            self.reply(403); return False
        return True
    def target(self):
        if not re.fullmatch(r'/mail-storage/[a-f0-9-]{36}', self.path):
            self.reply(404); return None
        return ROOT / self.path.rsplit('/',1)[1]
    def do_GET(self):
        if not self.authorized(): return
        if self.path == '/mail-storage/health':
            self.reply(200, b'{"ok":true}'); return
        target = self.target()
        if target is None: return
        try: stream=target.open('rb')
        except FileNotFoundError: self.reply(404); return
        with stream:
            self.send_response(200)
            self.send_header('Content-Type','application/octet-stream')
            self.send_header('Content-Disposition','attachment')
            self.send_header('Content-Length',str(os.fstat(stream.fileno()).st_size))
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.end_headers()
            shutil.copyfileobj(stream,self.wfile,65536)
    def do_PUT(self):
        if not self.authorized(): return
        target=self.target()
        if target is None: return
        try: size=int(self.headers.get('Content-Length','0'))
        except ValueError: self.reply(400); return
        if not 0<size<=MAX_FILE or self.headers.get('Transfer-Encoding'): self.reply(413); return
        temporary=None
        # Serialize reservations and writes to enforce the global disk quota exactly.
        with LOCK:
            if target.exists(): self.reply(409); return
            used=sum(p.stat().st_size for p in ROOT.iterdir() if p.is_file())
            if used+size>MAX_TOTAL or shutil.disk_usage(ROOT).free<size+1024**3: self.reply(507); return
            try:
                with tempfile.NamedTemporaryFile(dir=ROOT,prefix='.upload-',delete=False) as out:
                    temporary=Path(out.name); remaining=size
                    while remaining:
                        chunk=self.rfile.read(min(65536,remaining))
                        if not chunk: raise ConnectionError('Incomplete upload')
                        out.write(chunk); remaining-=len(chunk)
                    out.flush(); os.fsync(out.fileno())
                os.replace(temporary,target); temporary=None
                self.reply(201)
            except (OSError,ConnectionError):
                self.close_connection=True
            finally:
                if temporary is not None: temporary.unlink(missing_ok=True)
    def do_DELETE(self):
        if not self.authorized(): return
        target=self.target()
        if target is not None:
            with LOCK: target.unlink(missing_ok=True)
            self.reply(204)

class Server(socketserver.ThreadingMixIn,http.server.HTTPServer):
    daemon_threads=True
    def process_request(self,request,client_address):
        if not SLOTS.acquire(blocking=False):
            request.close(); return
        try: super().process_request(request,client_address)
        except Exception: SLOTS.release(); raise
    def process_request_thread(self,request,client_address):
        try: super().process_request_thread(request,client_address)
        finally: SLOTS.release()

if __name__=='__main__':
    ROOT.mkdir(parents=True,exist_ok=True)
    if len(SECRET.read_text().strip())<40: raise RuntimeError('Storage credential missing')
    Server(('127.0.0.1',8091),Handler).serve_forever()
