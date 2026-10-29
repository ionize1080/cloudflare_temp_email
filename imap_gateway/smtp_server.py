"""Authenticated implicit-TLS SMTP submission, using the existing private API."""
import base64
import logging
import time
from collections import OrderedDict, defaultdict

from twisted.cred.portal import IRealm, Portal
from twisted.internet import defer, protocol, threads
from twisted.mail import imap4, smtp
from zope.interface import implementer

MAX_MESSAGE = 1024 * 1024
MAX_RECIPIENTS = 20

# Only known, fixed API errors may reach a client or the journal. Never echo
# provider responses, message contents, credentials, or arbitrary error pages.
API_ERRORS = {
    'Invalid message, sender or recipients': ('invalid_message', 554, b'5.6.0 Invalid message or envelope recipients'),
    'Invalid MIME encoding': ('invalid_mime', 554, b'5.6.0 Invalid MIME encoding'),
    'From must match the authenticated mailbox': ('sender_mismatch', 550, b'5.7.1 From and Sender headers must match the SMTP login'),
    'Exactly one From header is required': ('from_header_count', 550, b'5.7.1 Exactly one From header is required'),
    'From header must contain one mailbox': ('from_mailbox_count', 550, b'5.7.1 From header must contain one mailbox'),
    'From address must match the authenticated mailbox': ('from_address', 550, b'5.7.1 From address must match the SMTP login'),
    'Sender header must match the authenticated mailbox': ('sender_header', 550, b'5.7.1 Sender header must match the SMTP login'),
    'Resent headers are not supported; compose a new message': ('resent_headers', 550, b'5.7.1 Resent headers unsupported; compose a new message'),
    'Recipient is blocked': ('recipient_blocked', 550, b'5.7.1 Recipient blocked by administrator'),
    'Include at least one envelope recipient in the To header': ('missing_to', 554, b'5.6.0 A To recipient must match an envelope recipient'),
    'Sending permission revoked': ('send_permission', 550, b'5.7.1 Sending permission is not enabled; request administrator approval'),
    'Sending permission or remaining quota unavailable': ('send_quota', 550, b'5.7.1 Sending permission or quota insufficient for all recipients'),
    'This submission was rejected; correct the message before retrying': ('previous_rejection', 554, b'5.6.0 Message was rejected; correct it before retrying'),
    'Outgoing provider rejected this message': ('provider_rejected', 554, b'5.6.0 Outgoing provider rejected this message; contact administrator'),
    'Invalid sender domain': ('sender_domain', 553, b'5.7.1 Sender domain is not enabled'),
    'IMAP permission revoked or session expired': ('session_expired', 535, b'5.7.8 Client permission revoked or session expired; reconnect'),
    'IMAP authentication required': ('session_invalid', 535, b'5.7.8 SMTP session invalid; reconnect'),
    'Previous delivery outcome requires administrator review': ('delivery_review', 451, b'4.3.0 Previous delivery outcome requires administrator review'),
    'Submission is processing; retry later': ('processing', 451, b'4.3.0 Submission is processing; retry the same message later'),
}


def submission_error(response):
    status = response.status_code
    reason = API_ERRORS.get(response.text.strip())
    if not reason:
        if status == 413: reason = ('message_size', 552, b'5.3.4 Message exceeds 1 MiB')
        elif status == 429: reason = ('rate_limit', 451, b'4.7.0 Sending rate limit reached; retry later')
        else: reason = ('submission_unavailable', 451, b'4.3.0 Submission unavailable; retry the same message later')
    logging.getLogger(__name__).warning('SMTP submission refused: reason=%s http_status=%s', reason[0], status)
    return smtp.SMTPServerError(reason[1], reason[2])


@implementer(smtp.IMessage)
class Message:
    def __init__(self, delivery, leader):
        self.delivery, self.leader, self.lines, self.size = delivery, leader, [], 0

    def lineReceived(self, line):
        if not self.leader: return
        self.size += len(line) + 2
        if self.size > MAX_MESSAGE:
            self.lines.clear()
            raise smtp.SMTPServerError(552, b'Message exceeds 1 MiB')
        self.lines.append(line)

    def eomReceived(self):
        if not self.leader: return defer.succeed(None)
        data = {'from': self.delivery.identity['address'], 'recipients': self.delivery.recipients.copy(),
                'raw': base64.b64encode(b'\r\n'.join(self.lines) + b'\r\n').decode('ascii')}
        self.lines.clear()
        def work():
            gateway = self.delivery.gateway
            try:
                response = gateway.client.post('/imap_api/smtp/submit', json=data,
                    headers={'Authorization': 'Bearer ' + gateway.token})
            except Exception:
                raise smtp.SMTPServerError(451, b'Submission unavailable; retry later') from None
            if response.status_code == 200: return
            raise submission_error(response)
        return threads.deferToThread(work)

    def connectionLost(self): self.lines.clear()


@implementer(smtp.IMessageDelivery)
class Delivery:
    def __init__(self, gateway, identity):
        self.gateway, self.identity, self.recipients = gateway, identity, []
        self.instances = 0

    def receivedHeader(self, helo, origin, recipients): return None

    def validateFrom(self, helo, origin):
        if str(origin).lower() != self.identity['address']:
            raise smtp.SMTPBadSender(origin, code=553, resp=b'Sender must match authenticated mailbox')
        self.recipients, self.instances = [], 0
        # DATA checks the permission again and atomically reserves quota.
        return threads.deferToThread(self.gateway.request, 'GET', 'session').addCallback(lambda _: origin)

    def validateTo(self, user):
        address = str(user.dest).lower()
        if len(self.recipients) >= MAX_RECIPIENTS or '@' not in address or not address.isascii():
            raise smtp.SMTPBadRcpt(user, code=552, resp=b'Invalid recipient or recipient limit reached')
        self.recipients.append(address)
        def factory():
            self.instances += 1
            return Message(self, self.instances == 1)
        return factory


@implementer(IRealm)
class Realm:
    def requestAvatar(self, avatarId, mind, *interfaces):
        gateway, identity = avatarId
        return smtp.IMessageDelivery, Delivery(gateway, identity), gateway.close


class Server(smtp.ESMTP):
    noisy = False
    timeout = 180

    def __init__(self):
        super().__init__({b'PLAIN': imap4.PLAINCredentials, b'LOGIN': smtp.LOGINCredentials})
        self.busy = False

    def greeting(self): return b'IONACS ESMTP submission ready'

    def extensions(self):
        return {b'AUTH': [b'PLAIN', b'LOGIN'], b'SIZE': [str(MAX_MESSAGE).encode()], b'8BITMIME': None}

    def connectionMade(self):
        self.peer_ip = self.transport.getPeer().host
        self.factory.connections[self.peer_ip] += 1
        super().connectionMade()
        if self.factory.connections[self.peer_ip] > 8 or sum(self.factory.connections.values()) > 24:
            self.sendCode(421, b'Connection limit'); self.transport.loseConnection()

    def connectionLost(self, reason):
        self.factory.connections[self.peer_ip] -= 1
        if not self.factory.connections[self.peer_ip]: del self.factory.connections[self.peer_ip]
        super().connectionLost(reason)

    def state_COMMAND(self, line):
        if self.busy:
            self.sendCode(451, b'Wait for previous command'); return
        return super().state_COMMAND(line)

    def ext_AUTH(self, rest):
        if not rest.strip(): self.sendCode(501, b'Authentication mechanism required'); return
        if not self.factory.allow_attempt(self.peer_ip):
            self.sendCode(454, b'Too many authentication attempts'); return
        return super().ext_AUTH(rest)

    def state_AUTH(self, response):
        # Block pipelined commands while asynchronous credential validation runs.
        try:
            result = super().state_AUTH(response)
            if self.mode == smtp.COMMAND and self.challenger is not None: self.busy = True
            return result
        except (ValueError, imap4.IllegalClientResponse):
            self.mode, self.challenger, self.busy = smtp.COMMAND, None, False
            self.sendCode(501, b'Invalid authentication response')

    def _cbAuthenticated(self, info):
        self.busy = False
        return super()._cbAuthenticated(info)

    def _ebAuthenticated(self, reason):
        self.busy = False
        self.challenger = None
        return super()._ebAuthenticated(reason)

    def do_MAIL(self, rest):
        if not self.authenticated: self.sendCode(530, b'Authentication required'); return
        # ESMTP MAIL options are not part of the envelope address.
        parts = rest.split(b'>', 1)
        if len(parts) == 2:
            for option in parts[1].strip().split():
                if option.upper().startswith(b'SIZE='):
                    try:
                        if int(option[5:]) > MAX_MESSAGE: self.sendCode(552, b'Message exceeds 1 MiB'); return
                    except ValueError: self.sendCode(501, b'Invalid size'); return
                elif option.upper() != b'BODY=8BITMIME': self.sendCode(555, b'Unsupported MAIL option'); return
            rest = parts[0] + b'>'
        super().do_MAIL(rest)

    def validateFrom(self, helo, origin):
        self.busy = True
        return super().validateFrom(helo, origin)

    def _cbFromValidate(self, value):
        self.busy = False
        return super()._cbFromValidate(value)

    def _ebFromValidate(self, reason):
        self.busy = False
        self.sendCode(550, b'Sender or client permission unavailable')

    def dataLineReceived(self, line):
        if line == b'.' and not self.datafailed: self.busy = True
        return super().dataLineReceived(line)

    def _messageHandled(self, results):
        self.busy = False
        for success, result in results:
            if not success:
                error = result.value
                if isinstance(error, smtp.SMTPServerError): self.sendCode(error.code, error.resp)
                else: self.sendCode(451, b'Submission unavailable; retry later')
                return
        self.sendCode(250, b'Message accepted for delivery')


class SmtpFactory(protocol.Factory):
    def __init__(self, checker):
        self.portal = Portal(Realm(), [checker])
        self.connections, self.attempts = defaultdict(int), OrderedDict()

    def allow_attempt(self, ip):
        now = time.monotonic(); start, count = self.attempts.get(ip, (now, 0))
        if now - start >= 60: start, count = now, 0
        self.attempts[ip] = (start, count + 1); self.attempts.move_to_end(ip)
        while len(self.attempts) > 10000: self.attempts.popitem(last=False)
        return count < 10

    def buildProtocol(self, addr):
        server = Server(); server.factory = self; server.portal = self.portal
        return server
