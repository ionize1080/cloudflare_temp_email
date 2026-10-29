"""Real TLS SMTP client tests; provider is synthetic and never delivers mail."""
import base64, smtplib, ssl, sys, threading, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from twisted.cred.error import UnauthorizedLogin
from twisted.internet import defer, reactor, ssl as tssl
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from imap_gateway.smtp_server import SmtpFactory, submission_error
from imap_gateway.server import Checker, sent_bytes

class Gateway:
    def __init__(self): self.token='test'; self.client=self; self.messages=[]; self.status=200; self.revoked=False; self.error='Sending permission revoked'
    def close(self): pass
    def request(self,*args,**kwargs):
        if self.revoked: raise UnauthorizedLogin()
        return {'address':'alice@example.com'}
    def post(self,path,**kwargs):
        self.messages.append(kwargs['json'])
        return type('Result',(),{'status_code':401 if self.revoked else self.status, 'text':self.error})()

class FakeChecker(Checker):
    def __init__(self): self.gateways=[]
    def requestAvatarId(self, credentials):
        if credentials.username!=b'alice@example.com' or credentials.password!=b'a'*48: return defer.fail(UnauthorizedLogin())
        g=Gateway(); self.gateways.append(g)
        return defer.succeed((g,{'address':'alice@example.com'}))

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048); name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
        cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc)-timedelta(minutes=1)).not_valid_after(datetime.now(timezone.utc)+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False).sign(key,hashes.SHA256())
        pem=cert.public_bytes(serialization.Encoding.PEM); private=key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption())
        cls.context=ssl.create_default_context(cadata=pem.decode()); cls.checker=FakeChecker(); cls.factory=SmtpFactory(cls.checker)
        cls.listener=reactor.listenSSL(0,cls.factory,tssl.PrivateCertificate.loadPEM(pem+private).options(),interface='127.0.0.1'); cls.port=cls.listener.getHost().port
        cls.thread=threading.Thread(target=lambda:reactor.run(installSignalHandlers=False),daemon=True); cls.thread.start()
    @classmethod
    def tearDownClass(cls): reactor.callFromThread(reactor.stop); cls.thread.join(timeout=5)
    def client(self,auth=True):
        client=smtplib.SMTP_SSL('localhost',self.port,context=self.context,timeout=8); self.addCleanup(client.close); client.ehlo()
        if auth: client.login('alice@example.com','a'*48)
        return client
    def message(self): return b'From: alice@example.com\r\nTo: bob@example.net\r\nSubject: SMTP test\r\n\r\n.test\r\n'
    def test_unauthenticated_relay_and_bad_credentials_rejected(self):
        c=self.client(False); self.assertEqual(c.mail('alice@example.com')[0],530)
        with self.assertRaises(smtplib.SMTPAuthenticationError): c.login('alice@example.com','wrong')
    def test_tls_auth_multiple_recipients_and_single_preserved_mime_submission(self):
        c=self.client(); self.assertIn('auth',c.esmtp_features)
        self.assertEqual(c.sendmail('alice@example.com',['bob@example.net','hidden@example.net'],self.message()),{})
        messages=self.checker.gateways[-1].messages; self.assertEqual(len(messages),1)
        self.assertEqual(messages[0]['recipients'],['bob@example.net','hidden@example.net']); self.assertEqual(base64.b64decode(messages[0]['raw']),self.message())
        self.assertEqual(sent_bytes({'raw':__import__('json').dumps({'version':'smtp-v1','mime_base64':messages[0]['raw']})}),self.message())
    def test_spoofed_sender_and_oversized_mail_rejected(self):
        c=self.client(); self.assertGreaterEqual(c.mail('other@example.com')[0],500)
        c.rset(); self.assertEqual(c.mail('alice@example.com',['SIZE=1048577'])[0],552)
    def test_provider_denial_and_retryable_failure_are_not_reported_as_success(self):
        c=self.client(); g=self.checker.gateways[-1]
        for status,expected in ((403,550),(503,451)):
            g.status=status
            g.error='Sending permission revoked' if status==403 else 'Temporary upstream error'
            with self.assertRaises(smtplib.SMTPDataError) as e:c.sendmail('alice@example.com',['bob@example.net'],self.message())
            self.assertEqual(e.exception.smtp_code,expected)
    def test_precise_safe_errors_without_upstream_content_leaks(self):
        cases=[(403,'From must match the authenticated mailbox',553,b'From and Sender'),
               (403,'Sending permission revoked',550,b'administrator approval'),
               (403,'Sending permission or remaining quota unavailable',550,b'quota insufficient'),
               (400,'Include at least one envelope recipient in the To header',554,b'To recipient'),
               (401,'IMAP permission revoked or session expired',535,b'reconnect'),
               (403,'<html>secret token and private message</html>',451,b'Submission unavailable'),
               (413,'Request too large',552,b'1 MiB')]
        for status,text,code,detail in cases:
            with self.assertLogs('imap_gateway.smtp_server',level='WARNING') as logs:
                error=submission_error(type('Result',(),{'status_code':status,'text':text})())
            self.assertEqual(error.code,code); self.assertIn(detail,error.resp)
            self.assertNotIn('secret',str(logs.output)); self.assertNotIn(b'secret',error.resp)
    def test_revoked_session_cannot_submit(self):
        c=self.client(); self.checker.gateways[-1].revoked=True
        with self.assertRaises(smtplib.SMTPSenderRefused):c.sendmail('alice@example.com',['bob@example.net'],self.message())

if __name__=='__main__':unittest.main(verbosity=2)
