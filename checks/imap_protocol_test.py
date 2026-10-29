"""Real TLS/IMAP client tests with synthetic backend data, no external mail."""
import copy, imaplib, json, ssl as stdssl, sys, threading, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from twisted.cred.error import UnauthorizedLogin
from twisted.internet import defer, reactor, ssl
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from imap_gateway.server import Factory, Checker

RAW = 'From: sender@example.com\r\nTo: alice@example.com\r\nSubject: protocol test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test-boundary"\r\n\r\n--test-boundary\r\nContent-Type: text/plain\r\n\r\nhello\r\n--test-boundary\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="test.bin"\r\n\r\nAAECAwQ=\r\n--test-boundary--\r\n'

class FakeGateway:
    def __init__(self):
        self.records = [{'uid': 11, 'flags': '[]'}, {'uid': 42, 'flags': '[]'}]
        self.revoked = False
    def close(self): pass
    def request(self, method, path, **options):
        if self.revoked: raise UnauthorizedLogin('revoked')
        if path == 'session': return {'address': 'alice@example.com'}
        if path == 'messages': return {'results': copy.deepcopy(self.records), 'uidnext': 43, 'uidvalidity': 1}
        if path.startswith('message/'):
            return {'raw': RAW, 'folder': 'INBOX', 'created_at': '2026-10-29 00:00:00'}
        if path == 'flags':
            data = options['json']
            for record in self.records:
                if record['uid'] not in data['uids']: continue
                old, flags = set(json.loads(record['flags'])), set(data['flags'])
                record['flags'] = json.dumps(sorted(flags if data['mode'] == 0 else old | flags if data['mode'] == 1 else old - flags))
            return {'results': copy.deepcopy([r for r in self.records if r['uid'] in data['uids']])}
        if path == 'expunge':
            self.records = [r for r in self.records if '\\Deleted' not in json.loads(r['flags'])]
            return {'success': True}
        raise AssertionError(path)

class FakeChecker(Checker):
    def __init__(self): self.gateways = []
    def requestAvatarId(self, credentials):
        if credentials.username != b'alice@example.com' or credentials.password != b'a' * 48:
            return defer.fail(UnauthorizedLogin())
        gateway = FakeGateway(); self.gateways.append(gateway)
        return defer.succeed((gateway, {'address': 'alice@example.com', 'uidvalidity': 1}))

class ImapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')])
        cert = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1)).not_valid_after(datetime.now(timezone.utc) + timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), critical=False).sign(key, hashes.SHA256())
        pem = cert.public_bytes(serialization.Encoding.PEM)
        private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption())
        cls.context = stdssl.create_default_context(cadata=pem.decode())
        cls.checker = FakeChecker(); cls.factory = Factory(cls.checker)
        cls.listener = reactor.listenSSL(0, cls.factory, ssl.PrivateCertificate.loadPEM(pem + private).options(), interface='127.0.0.1')
        cls.port = cls.listener.getHost().port
        cls.thread = threading.Thread(target=lambda: reactor.run(installSignalHandlers=False), daemon=True); cls.thread.start()

    @classmethod
    def tearDownClass(cls): reactor.callFromThread(reactor.stop); cls.thread.join(timeout=5)

    def client(self):
        client = imaplib.IMAP4_SSL('localhost', self.port, ssl_context=self.context, timeout=10)
        self.addCleanup(lambda: client.logout() if client.state != 'LOGOUT' else None)
        return client

    def test_rejects_wrong_password(self):
        client = self.client()
        with self.assertRaises(imaplib.IMAP4.error): client.login('alice@example.com', 'wrong')

    def test_tls_login_list_search_uid_fetch_attachment_and_flags(self):
        client = self.client(); self.assertEqual(client.login('alice@example.com', 'a' * 48)[0], 'OK')
        self.assertEqual(client.list()[0], 'OK'); self.assertEqual(client.select('INBOX'), ('OK', [b'2']))
        self.assertEqual(client.uid('SEARCH', None, 'ALL'), ('OK', [b'11 42']))
        result, rows = client.uid('FETCH', '42', '(UID RFC822.SIZE BODY.PEEK[])')
        self.assertEqual(result, 'OK'); self.assertIn(b'UID 42', rows[0][0]); self.assertEqual(rows[0][1], RAW.encode())
        self.assertEqual(client.uid('STORE', '42', '+FLAGS', '(\\Seen)')[0], 'OK')
        self.assertEqual(client.uid('SEARCH', None, 'SEEN'), ('OK', [b'42']))
        self.assertEqual(client.uid('FETCH', '1:*', '(UID FLAGS)')[0], 'OK')
        self.assertEqual(client.uid('SEARCH', None, 'FROM', '"sender@example.com"'), ('OK', [b'11 42']))
        self.assertEqual(client.uid('FETCH', '11', '(BODYSTRUCTURE BODY.PEEK[2])')[0], 'OK')
        self.assertEqual(client.uid('FETCH', '11', '(BODY[])')[0], 'OK')
        self.assertEqual(client.uid('SEARCH', None, 'SEEN'), ('OK', [b'11 42']))
        self.checker.gateways[-1].records.append({'uid': 99, 'flags': '[]'})
        self.assertEqual(client.noop()[0], 'OK')
        self.assertEqual(client.uid('SEARCH', None, 'ALL'), ('OK', [b'11 42 99']))

    def test_examine_is_readonly_and_expunge_preserves_stable_uids(self):
        client = self.client(); client.login('alice@example.com', 'a' * 48); client.select('INBOX', readonly=True)
        with self.assertRaises(imaplib.IMAP4.error): client.uid('STORE', '11', '+FLAGS', '(\\Deleted)')
        client.select('INBOX'); self.assertEqual(client.uid('STORE', '11', '+FLAGS', '(\\Deleted)')[0], 'OK')
        self.assertEqual(client.expunge(), ('OK', [b'1']))
        self.assertEqual(client.uid('SEARCH', None, 'ALL'), ('OK', [b'42']))
        self.assertIn(b'UID 42', client.fetch('1', '(UID FLAGS)')[1][0])

    def test_revocation_blocks_existing_session_reads(self):
        client = self.client(); client.login('alice@example.com', 'a' * 48); client.select('INBOX')
        self.checker.gateways[-1].revoked = True
        with self.assertRaises(imaplib.IMAP4.error): client.uid('FETCH', '11', '(UID FLAGS)')

if __name__ == '__main__': unittest.main(verbosity=2)
