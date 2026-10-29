"""IONACS TLS IMAP gateway. Email remains in Workers/D1; no on-disk mail cache."""
import copy
import base64
import json
import os
import time
from collections import OrderedDict, defaultdict
from datetime import datetime, timezone
from email import policy
from email.message import EmailMessage
from email.header import decode_header, make_header
from email.parser import BytesParser
from email.utils import format_datetime, formataddr
from io import BytesIO

import httpx
from twisted.cred.checkers import ICredentialsChecker
from twisted.cred.credentials import IUsernamePassword
from twisted.cred.error import UnauthorizedLogin
from twisted.cred.portal import IRealm, Portal
from twisted.internet import defer, protocol, reactor, ssl, task, threads
from twisted.mail import imap4
from zope.interface import implementer

FLAGS = ['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft']


class Gateway:
    def __init__(self, base_url, headers):
        self.client = httpx.Client(base_url=base_url.rstrip('/'), headers=headers,
                                   timeout=20, follow_redirects=False,
                                   limits=httpx.Limits(max_connections=4))
        self.token = None

    def request(self, method, path, **kwargs):
        headers = {'Authorization': 'Bearer ' + self.token} if self.token else {}
        try:
            with self.client.stream(method, '/imap_api/' + path, headers=headers, **kwargs) as response:
                if response.status_code in (401, 403):
                    raise UnauthorizedLogin('IMAP access denied')
                if response.status_code != 200:
                    raise imap4.MailboxException('Mailbox service unavailable')
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > 16 * 1024 * 1024:
                        raise imap4.MailboxException('Message exceeds gateway limit')
                    chunks.append(chunk)
                return json.loads(b''.join(chunks))
        except httpx.HTTPError:
            raise imap4.MailboxException('Mailbox service unavailable') from None

    def close(self):
        self.client.close()


def sent_bytes(item):
    data = json.loads(item['raw'])
    if data.get('version') == 'smtp-v1': return base64.b64decode(data['mime_base64'], validate=True)
    msg = EmailMessage(policy=policy.SMTP)
    if data.get('version') == 'v2':
        msg['From'] = formataddr((data.get('from_name', ''), item['address']))
        msg['To'] = formataddr((data.get('to_name', ''), data['to_mail']))
        msg.set_content(data.get('content', ''), subtype='html' if data.get('is_html') else 'plain')
    else:
        sender = data.get('from', {})
        msg['From'] = formataddr((sender.get('name', ''), sender.get('email', item['address'])))
        msg['To'] = ', '.join(formataddr((x.get('name', ''), x['email'])) for x in data['personalizations'][0]['to'])
        content = data.get('content', [{}])[0]
        msg.set_content(content.get('value', ''), subtype='html' if 'html' in content.get('type', '') else 'plain')
    msg['Subject'] = data.get('subject', '')
    msg['Date'] = format_datetime(datetime.fromisoformat(item['created_at']).replace(tzinfo=timezone.utc))
    msg['Message-ID'] = '<ionacs-sent-%s@%s>' % (item['uid'], item['address'].split('@')[-1])
    return msg.as_bytes()


@implementer(imap4.IMessage, imap4.IMessageFile)
class Message:
    def __init__(self, mailbox=None, record=None, raw=None):
        self.mailbox, self.record, self.raw = mailbox, record or {}, raw
        self.parsed = BytesParser(policy=policy.compat32).parsebytes(raw) if raw is not None else None
        self.created_at = None

    def load(self):
        if self.raw is None:
            item = self.mailbox.gateway.request('GET', 'message/' + str(self.record['uid']))
            self.raw = item['raw'].encode('utf-8') if item['folder'] == 'INBOX' else sent_bytes(item)
            # RFC822 uses CRLF; preserve all original MIME boundaries/attachments.
            self.raw = self.raw.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
            self.parsed = BytesParser(policy=policy.compat32).parsebytes(self.raw)
            self.created_at = item['created_at']
        return self

    def release(self):
        self.raw = self.parsed = None

    def getUID(self): return self.record['uid']
    def getFlags(self): return json.loads(self.record.get('flags', '[]'))
    def getSize(self): return len(self.raw)
    def open(self): return BytesIO(self.raw)
    def isMultipart(self): return self.parsed.is_multipart()
    def getInternalDate(self):
        return format_datetime(datetime.fromisoformat(self.created_at).replace(tzinfo=timezone.utc)).encode('ascii')

    def getHeaders(self, negate, *names):
        names = {n.lower() for n in names}
        return {k.lower(): str(v) for k, v in self.parsed.items() if (k.lower() not in names if negate else k.lower() in names)}

    def getBodyFile(self): return BytesIO(self.raw.partition(b'\r\n\r\n')[2])
    def getSubPart(self, part):
        if not self.isMultipart(): raise TypeError('Not multipart')
        return Message(raw=self.parsed.get_payload()[part].as_bytes(policy=policy.SMTP))


class SearchMessage:
    """Twisted's search parser uses byte criteria; MIME serializers use text."""
    def __init__(self, message): self.message = message
    def __getattr__(self, name): return getattr(self.message, name)
    def getHeaders(self, negate, *names):
        names = tuple(n.decode('ascii') if isinstance(n, bytes) else n for n in names)
        headers = self.message.getHeaders(negate, *names)
        result = {}
        for name, value in headers.items():
            try: result[name] = str(make_header(decode_header(value))).encode('utf-8')
            except (LookupError, UnicodeError): result[name] = value.encode('utf-8', errors='replace')
        for name in names:
            if not negate: result.setdefault(name.lower(), b'')
        return result


@implementer(imap4.IMailboxInfo, imap4.IMailbox, imap4.ISearchableMailbox)
class Mailbox:
    def __init__(self, gateway, name, validity):
        self.gateway, self.name, self.validity = gateway, name, validity
        self.records, self.listeners, self.uidnext, self.writeable = [], [], 1, True

    def read_snapshot_sync(self):
        records, after = [], 0
        while True:
            result = self.gateway.request('GET', 'messages', params={'folder': self.name, 'after': after})
            records.extend(result['results'])
            if len(records) > 100000: raise imap4.MailboxException('Mailbox too large')
            if len(result['results']) < 1000: break
            after = records[-1]['uid']
        return records, result['uidnext']

    def refresh_sync(self):
        self.records, self.uidnext = self.read_snapshot_sync()
        return self

    def addListener(self, listener): self.listeners.append(listener)
    def removeListener(self, listener):
        if listener in self.listeners: self.listeners.remove(listener)
    def getFlags(self): return FLAGS
    def getHierarchicalDelimiter(self): return '/'
    def getUIDValidity(self): return self.validity
    def getUIDNext(self): return self.uidnext
    def getMessageCount(self): return len(self.records)
    def getRecentCount(self): return 0
    def getUnseenCount(self): return sum('\\Seen' not in json.loads(r['flags']) for r in self.records)
    def isWriteable(self): return self.writeable
    def getUID(self, sequence): return self.records[sequence - 1]['uid']
    def destroy(self): raise imap4.MailboxException('System folders cannot be deleted')
    def addMessage(self, *args, **kwargs): raise imap4.MailboxException('Uploading messages is not supported; use webmail to send')

    def requestStatus(self, names):
        return threads.deferToThread(self.refresh_sync).addCallback(lambda _: imap4.statusRequestHelper(self, names))

    def selected(self, messages, uid):
        if not self.records: return []
        messages.last = self.records[-1]['uid'] if uid else len(self.records)
        return [(i, r) for i, r in enumerate(self.records, 1) if (r['uid'] if uid else i) in messages]

    def fetch(self, messages, uid):
        # Validate revocation even for metadata-only FETCH, before using snapshot.
        return threads.deferToThread(self.gateway.request, 'GET', 'session').addCallback(
            lambda _: [(i, Message(self, r)) for i, r in self.selected(messages, uid)])

    def store(self, messages, flags, mode, uid):
        if not self.writeable: raise imap4.MailboxException('Mailbox selected read-only')
        if any(f not in FLAGS for f in flags): raise imap4.MailboxException('Unsupported flag')
        records = self.selected(messages, uid)
        def work():
            result = {}
            for start in range(0, len(records), 100):
                chunk = records[start:start + 100]
                data = self.gateway.request('POST', 'flags', json={'uids': [r['uid'] for _, r in chunk], 'flags': flags, 'mode': mode})
                changed = {r['uid']: r['flags'] for r in data['results']}
                for sequence, record in chunk:
                    if record['uid'] in changed:
                        record['flags'] = changed[record['uid']]
                        result[sequence] = json.loads(record['flags'])
            return result
        return threads.deferToThread(work)

    def expunge(self):
        if not self.writeable: raise imap4.MailboxException('Mailbox selected read-only')
        before = [r['uid'] for r in self.records]
        def work():
            self.gateway.request('POST', 'expunge', json={'folder': self.name})
            self.refresh_sync()
            current = {r['uid'] for r in self.records}
            return [i for i, uid in reversed(list(enumerate(before, 1))) if uid not in current]
        return threads.deferToThread(work)

    def search(self, query, uid):
        metadata_keys = {b'ALL', b'SEEN', b'UNSEEN', b'ANSWERED', b'UNANSWERED', b'FLAGGED', b'UNFLAGGED', b'DELETED', b'UNDELETED', b'DRAFT', b'UNDRAFT', b'NEW', b'OLD', b'RECENT'}
        metadata_only = all(isinstance(q, bytes) and q.upper() in metadata_keys for q in query)
        def work():
            self.gateway.request('GET', 'session')
            searcher, matches = imap4.IMAP4Server(), []
            for sequence, record in enumerate(self.records, 1):
                msg = Message(self, record)
                if not metadata_only: msg.load()
                if searcher._searchFilter(copy.deepcopy(query), sequence, SearchMessage(msg), len(self.records), self.records[-1]['uid']): matches.append(sequence)
                msg.release()
            return matches
        return threads.deferToThread(work)


class Account(imap4.MemoryAccount):
    def __init__(self, gateway, identity):
        super().__init__(identity['address'])
        self.gateway = gateway
        for name in ('INBOX', 'SENT'):
            self.addMailbox(name, Mailbox(gateway, name, identity['uidvalidity']))
            self.subscribe(name)

    def select(self, name, readwrite=1):
        mailbox = super().select(name, readwrite)
        if mailbox is None: return None
        mailbox.writeable = bool(readwrite)
        return threads.deferToThread(mailbox.refresh_sync)
    def create(self, name): raise imap4.MailboxException('Custom folders are not supported')
    def rename(self, old, new): raise imap4.MailboxException('System folders cannot be renamed')


@implementer(IRealm)
class Realm:
    def requestAvatar(self, avatarId, mind, *interfaces):
        gateway, identity = avatarId
        return imap4.IAccount, Account(gateway, identity), gateway.close


@implementer(ICredentialsChecker)
class Checker:
    credentialInterfaces = (IUsernamePassword,)
    def __init__(self, base_url, headers): self.base_url, self.headers = base_url, headers
    def requestAvatarId(self, credentials):
        def work():
            gateway = Gateway(self.base_url, self.headers)
            try:
                username, password = credentials.username.decode('utf-8'), credentials.password.decode('ascii')
                if len(username) > 254 or len(password) != 48: raise UnauthorizedLogin()
                identity = gateway.request('POST', 'authenticate', json={'username': username, 'password': password})
                gateway.token = identity['token']
                return gateway, identity
            except Exception:
                gateway.close()
                raise UnauthorizedLogin('Authentication failed') from None
        return threads.deferToThread(work)


class Server(imap4.IMAP4Server):
    timeOut = 1800
    IDENT = b'IONACS IMAP ready'
    def connectionMade(self):
        self.peer_ip = self.transport.getPeer().host
        self.factory.connections[self.peer_ip] += 1
        self.failed = 0
        super().connectionMade()
        if self.factory.connections[self.peer_ip] > 8 or sum(self.factory.connections.values()) > 48:
            self.sendLine(b'* BYE Connection limit'); self.transport.loseConnection(); return
        self.poller = task.LoopingCall(self.poll)
        self.poller.start(60, now=False).addErrback(lambda _: None)

    def connectionLost(self, reason):
        self.factory.connections[self.peer_ip] -= 1
        if not self.factory.connections[self.peer_ip]: del self.factory.connections[self.peer_ip]
        if hasattr(self, 'poller') and self.poller.running: self.poller.stop()
        super().connectionLost(reason)

    def authenticateLogin(self, username, password):
        if not self.factory.allow_attempt(self.peer_ip): return defer.fail(UnauthorizedLogin('Try later'))
        result = super().authenticateLogin(username, password)
        def failed(failure):
            self.failed += 1
            if self.failed >= 5: reactor.callLater(1, self.transport.loseConnection)
            return failure
        return result.addErrback(failed)

    def spewMessage(self, sequence, msg, query, uid):
        needs_body = any(part.type not in ('uid', 'flags') for part in query)
        result = threads.deferToThread(msg.load) if needs_body else defer.succeed(msg)
        mark_seen = msg.mailbox.writeable and any(part.type in ('rfc822', 'rfc822text') or (part.type == 'body' and not part.peek) for part in query)
        if mark_seen and '\\Seen' not in msg.getFlags():
            def mark(_):
                return threads.deferToThread(msg.mailbox.gateway.request, 'POST', 'flags', json={'uids': [msg.getUID()], 'flags': ['\\Seen'], 'mode': 1})
            def marked(data):
                if data['results']:
                    msg.record['flags'] = data['results'][0]['flags']
                    self.flagsChanged({sequence: msg.getFlags()})
            result.addCallback(mark).addCallback(marked)
        def emit(_): return super(Server, self).spewMessage(sequence, msg, query, uid)
        def release(result): msg.release(); return result
        return result.addCallback(emit).addBoth(release)

    def do_NOOP(self, tag):
        if self.state != 'select':
            self.sendPositiveResponse(tag, b'NOOP completed'); return
        self.blocked = []
        mailbox = self.mbox
        previous = [r['uid'] for r in mailbox.records]
        def changed(snapshot):
            mailbox.records, mailbox.uidnext = snapshot
            self.announce_changes(mailbox, previous)
            self.sendPositiveResponse(tag, b'NOOP completed')
            self._unblock()
        def failed(_):
            self.sendLine(b'* BYE Mailbox access unavailable')
            self.transport.loseConnection()
        return threads.deferToThread(mailbox.read_snapshot_sync).addCallback(changed).addErrback(failed)

    auth_NOOP = (do_NOOP,)
    select_NOOP = auth_NOOP

    def announce_changes(self, mailbox, previous):
        current = {r['uid'] for r in mailbox.records}
        for sequence, old in reversed(list(enumerate(previous, 1))):
            if old not in current: self.sendUntaggedResponse(b'%d EXPUNGE' % sequence)
        self.newMessages(mailbox.getMessageCount(), 0)

    def poll(self):
        if self.state not in ('auth', 'select') or self.blocked is not None or self.parseState not in ('command', 'idle'): return
        def denied(_):
            self.sendLine(b'* BYE Session expired, permission revoked, or service unavailable')
            self.transport.loseConnection()
        # Refresh selected folders on IDLE only; never emit EXPUNGE amid FETCH.
        if self.state == 'select' and self.parseState == 'idle':
            mailbox = self.mbox
            previous = [r['uid'] for r in mailbox.records]
            def changed(snapshot):
                if self.mbox is not mailbox or self.parseState != 'idle' or self.blocked is not None: return
                mailbox.records, mailbox.uidnext = snapshot
                self.announce_changes(mailbox, previous)
            return threads.deferToThread(mailbox.read_snapshot_sync).addCallback(changed).addErrback(denied)
        return threads.deferToThread(self.account.gateway.request, 'GET', 'session').addErrback(denied)


class Factory(protocol.Factory):
    def __init__(self, checker):
        self.portal, self.connections, self.attempts = Portal(Realm(), [checker]), defaultdict(int), OrderedDict()
    def allow_attempt(self, ip):
        now = time.monotonic()
        start, count = self.attempts.get(ip, (now, 0))
        if now - start >= 60: start, count = now, 0
        self.attempts[ip] = (start, count + 1)
        self.attempts.move_to_end(ip)
        while len(self.attempts) > 10000: self.attempts.popitem(last=False)
        return count < 10
    def buildProtocol(self, addr):
        server = Server(); server.factory = self; server.portal = self.portal
        return server


def main():
    base = os.environ['IONACS_API_URL']
    if not base.startswith('https://'): raise SystemExit('HTTPS backend is required')
    headers = {'CF-Access-Client-Id': os.environ['CF_ACCESS_CLIENT_ID'],
               'CF-Access-Client-Secret': os.environ['CF_ACCESS_CLIENT_SECRET'],
               'x-imap-gateway-key': os.environ['IMAP_GATEWAY_SECRET']}
    certificate = ssl.PrivateCertificate.loadPEM(open(os.environ['IMAP_CERT'], 'rb').read() + open(os.environ['IMAP_KEY'], 'rb').read())
    # Include intermediates so clients can verify the public certificate chain.
    pem = open(os.environ['IMAP_CERT'], 'rb').read()
    blocks = [b + b'-----END CERTIFICATE-----\n' for b in pem.split(b'-----END CERTIFICATE-----') if b'BEGIN CERTIFICATE' in b]
    context = ssl.CertificateOptions(privateKey=certificate.privateKey.original, certificate=certificate.original,
                                     extraCertChain=[ssl.Certificate.loadPEM(b).original for b in blocks[1:]],
                                     raiseMinimumTo=ssl.TLSVersion.TLSv1_2)
    reactor.suggestThreadPoolSize(4)
    reactor.listenSSL(int(os.environ.get('IMAP_PORT', '993')), Factory(Checker(base, headers)), context,
                      interface=os.environ.get('IMAP_BIND', '0.0.0.0'))
    if os.environ.get('SMTP_PORT'):
        try: from .smtp_server import SmtpFactory
        except ImportError: from smtp_server import SmtpFactory
        submission_factory = SmtpFactory(Checker(base, headers))
        for port in {int(os.environ['SMTP_PORT']), int(os.environ.get('SMTP_ALT_PORT') or os.environ['SMTP_PORT'])}:
            reactor.listenSSL(port, submission_factory, context, interface=os.environ.get('IMAP_BIND', '0.0.0.0'))
    print('IONACS TLS mail gateway started', flush=True)
    reactor.run()


if __name__ == '__main__': main()
