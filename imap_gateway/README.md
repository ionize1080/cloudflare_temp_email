# IONACS IMAP gateway

This service translates TLS IMAP commands to the narrowly scoped Worker `/imap_api/*` API. Mail remains in D1; credentials, message bodies and the origin address must not be committed. It does not provide SMTP submission or arbitrary folders. Use the web composer for sending.

## Provisioning

1. Apply `db/2026-10-29-imap.sql` to the existing D1 database after taking a recovery bookmark. Deploy the updated Worker and Pages middleware.
2. Create a dedicated Cloudflare Access Service Auth application for `mail.ionacs.com/imap_api/*`, accepting only the gateway service token. Set its audience in `shared/security.mjs` and deploy both components. Preserve the existing web application and policies. Never use a bypass policy.
3. Store a cryptographically random `IMAP_GATEWAY_SECRET` and the chosen `IMAP_HOST` as Worker secrets. The hostname is intentionally absent from the public repository. The app advertises `IMAP_PORT` (default 993).
4. On the gateway server, create a non-login `ionacs-imap` user, put `server.py` and `requirements.txt` in `/opt/ionacs-imap`, create a Python 3.12-compatible virtual environment at `/opt/ionacs-imap/venv`, and install the pinned requirements. Ubuntu 22.04 Python 3.10 is also supported by the installed runtime dependencies.
5. Obtain a publicly trusted certificate for the randomized hostname. Install the certificate and key at `/etc/ionacs-imap/fullchain.pem` and `/etc/ionacs-imap/privkey.pem`, readable by `root:ionacs-imap` only (0640). Do not use self-signed certificates or disable verification.
6. Put the following settings in `/etc/ionacs-imap/gateway.env` (root-owned 0600). Replace every placeholder locally; keep this file outside Git.

```dotenv
IONACS_API_URL=https://mail.ionacs.com
CF_ACCESS_CLIENT_ID=<dedicated-service-client-id>
CF_ACCESS_CLIENT_SECRET=<dedicated-service-client-secret>
IMAP_GATEWAY_SECRET=<same-value-as-worker-secret>
IMAP_CERT=/etc/ionacs-imap/fullchain.pem
IMAP_KEY=/etc/ionacs-imap/privkey.pem
IMAP_PORT=993
```

7. Install `ionacs-imap.service` into `/etc/systemd/system`, reload systemd, enable and start it. The hardened service binds 993 as a non-root user, restarts after failures and has a 350 MiB memory cap. Preserve unrelated services and management access.
8. Install a certificate renewal deployment hook that copies the renewed full chain/key with the same ownership/mode and restarts this service. Enable and check the certificate provider's renewal timer. HTTP-01 renewal requires port 80 to be reachable during the renewal; the IMAP service itself uses only 993. Ensure no conflicting HTTP listener is introduced later.

For direct desktop/mobile clients, publish DNS-only A/AAAA records and allow inbound TCP on the chosen port. Ordinary Cloudflare HTTP proxying does not proxy IMAP. A DNS-only record reveals the origin IP. Alternate ports can work if supported by the client and server firewall, but cannot turn Workers into an inbound TCP listener.

## Updates and validation

Run `python checks/imap_protocol_test.py` from the repository root and the Node checks before release. Copy reviewed gateway files to `/opt/ionacs-imap`, update the venv if requirements changed, then restart `ionacs-imap`. Check service status and the certificate chain with a standard IMAP client. Never log credential values or mail contents. The GitHub workflow validates gateway code but does not automatically SSH into the server.

For production validation, use an isolated synthetic mailbox with explicitly enabled IMAP and a temporary app password. Verify login, LIST, SELECT, UID SEARCH/FETCH, STORE and EXPUNGE; revoke the password and check rejection, then remove only that fixture. No external email send is needed. Keep a D1 recovery bookmark before schema work.

Rotate the Access service token before its configured expiry, replace the gateway environment secret, restart the service and verify login. Rotate the gateway shared secret in the Worker and server together. Keep all operational credentials in a private secret store. A site/admin password is not an IMAP client password.

## Supported behavior

- TLS 1.2 or newer, LOGIN, INBOX/SENT, LIST/LSUB, SELECT/EXAMINE, STATUS, UID search/fetch, MIME attachments, standard flags, EXPUNGE and IDLE polling.
- BODY.PEEK preserves unread status; normal body retrieval marks Seen. Flags persist in D1 and UIDs are never reused.
- Access checks on data requests; idle authorization checks at 60-second intervals; sessions expire after 12 hours and reconnect normally.
- Five client passwords per mailbox, ten authentication attempts per IP/minute, eight connections per IP and 48 in total; Worker account-level rate limits also apply.
- Read-only selections reject writes. Deleted messages are permanent after EXPUNGE/CLOSE; no recovery Trash folder is advertised.
- No custom folders, APPEND/COPY or SMTP. Webmail's device-local read/star state does not synchronize with IMAP flags. Large message responses above 16 MiB and folders over 100,000 messages are rejected.

The separate API Access audience is accepted only for `/imap_api/`; all normal web/admin paths continue requiring the original web audience and their existing application credentials.
