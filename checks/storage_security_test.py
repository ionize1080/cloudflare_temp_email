"""Exercise the real private storage server using isolated temporary files."""
import http.client
import sys
import tempfile
import threading
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oracle_storage import server as storage

class StorageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        storage.ROOT = Path(cls.directory.name) / 'data'; storage.ROOT.mkdir()
        storage.SECRET = Path(cls.directory.name) / 'token'
        storage.SECRET.write_text('isolated-storage-token')
        cls.server = storage.Server(('127.0.0.1',0), storage.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.directory.cleanup()
    def request(self, method, path, body=None, auth=True, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        try:
            fields = {'Authorization':'Bearer isolated-storage-token'} if auth else {}
            fields.update(headers or {})
            conn.request(method,path,body,fields); response = conn.getresponse()
            return response.status,response.read(),dict(response.getheaders())
        finally: conn.close()
    def test_private_health_and_objects_require_authentication(self):
        for method in ('GET','PUT','DELETE'):
            self.assertEqual(self.request(method,'/mail-storage/health',auth=False)[0],403)
        self.assertEqual(self.request('GET','/mail-storage/health')[0],200)
    def test_traversal_size_and_overwrite_are_rejected(self):
        for path in ('/mail-storage/../token','/mail-storage/%2e%2e/token','/mail-storage/','/mail-storage/health?x=1'):
            self.assertEqual(self.request('GET',path)[0],404)
        path='/mail-storage/12345678-1234-1234-1234-123456789012'
        self.assertEqual(self.request('PUT',path,headers={'Content-Length':str(storage.MAX_FILE+1)})[0],413)
        self.assertEqual(self.request('PUT',path,b'attachment')[0],201)
        self.assertEqual(self.request('PUT',path,b'overwrite')[0],409)
        code,body,headers=self.request('GET',path)
        self.assertEqual((code,body),(200,b'attachment')); self.assertEqual(headers['Content-Disposition'],'attachment')
        self.assertEqual(self.request('DELETE',path)[0],204)
        self.assertEqual(self.request('GET',path)[0],404)

if __name__=='__main__': unittest.main(verbosity=2)
