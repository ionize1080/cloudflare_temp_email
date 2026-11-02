# IONACS Mail

Production: https://mail.ionacs.com. The former `m.ionacs.com` address and Pages preview hostnames redirect to the canonical origin. Existing mail domains (`ionacs.com`, `ioaaz.com`), D1 data, KV, Resend credentials are retained. Public webmail no longer requires a Cloudflare Access login; the IMAP service path retains its separate Access policy.

## Experience

Gmail-inspired, responsive Vue mailbox with a search bar, folder navigation, selection, read indicators, local stars, full-message reading, attachments, reply/forward, a floating/minimizable composer, session drafts, dark mode and keyboard shortcuts (`/` search, `c` compose, Ctrl/Command+Enter send). IONACS branding is independent of Google.

Search is scoped to the selected folder and searches stored raw content/sender fields. MIME-encoded words may not match their decoded equivalents. Stars and read indicators are stored on this device, not synchronized. Drafts are scoped to the selected mailbox in sessionStorage; closing the browser session or logging out clears them. The composer supports sanitized rich text, To/Cc/Bcc (20 total recipients), drag/drop attachments and a 25 MiB aggregate attachment limit. Each distinct recipient consumes one quota unit. Attachment bytes are stored privately on Oracle; session drafts contain only metadata. Unsent attachments expire after seven days. There is no pretend Trash folder: deletion requires explicit confirmation and is permanent, matching the existing API.

## Administration and sending requests

The Gmail-inspired admin workspace at `/admin` has a searchable sidebar, overview, sender approvals, mailbox/user management, security status, and operation history. Existing advanced settings remain under More Features and load on demand. Direct links such as `/admin?tab=senderAccess`, `/admin?tab=user_settings`, and `/admin?tab=security` open the appropriate section.

Mailbox users request permission from the compose window or mailbox/account panel. Requests always await administrator review; this fork does not automatically grant `DEFAULT_SEND_BALANCE`. Duplicate requests are idempotent and cannot reset existing quotas. Exhausted or disabled mailboxes can request review again. Administrators can review a pending request or configure an existing mailbox directly, choose whether sending is enabled, and set the remaining total quota (integer 0–100000). A successful change writes an internal notification; the user can click Refresh Status in the composer. Existing approved quotas are preserved.

The additive `db/2026-10-29-admin-console.sql` migration adds `address_sender.requested_at` and `admin_audit`, advancing the schema to v0.0.6. It has been applied to production after saving a Time Travel bookmark. Do not reapply its ALTER statement; the admin database migration checks column presence. Legacy disabled entries without a pending timestamp can still be managed from All or requested again by their owners.

Audit history records the administrator authentication identity, method, path (without query string), HTTP result and UTC time for authorized admin mutations and credential reads. It begins with this release and retains the latest 1000 records. Passwords, tokens, bodies and mail contents are not logged. Audit writes run with `waitUntil`; failures emit a structured error. This is operational history, not a tamper-proof compliance log. The admin page clears its cached management password after 15 idle minutes. Manual lock and logout are also available. Audit actors identify the shared admin credential rather than a personal Access email.

Mailbox deletion now removes related records before the address in a single D1 transaction, preventing orphaned mail/permission records and partial cleanup. No production deletions were used for validation. Immediate maintenance cleanup requires typing an explicit confirmation.

## Password accounts and IMAP clients

The mailbox login now accepts a full email address and password. New mailboxes choose a 12–128 character password during registration; an existing mailbox session can set or change its password in Mailbox & Account. Existing credential login remains available for migration. Passwords use individual random salts and PBKDF2-SHA256 (100,000 iterations, the Workers Web Crypto limit). Legacy password hashes are upgraded on successful login. Changing a mailbox password revokes its IMAP client passwords; it does not invalidate already-issued web mailbox JWTs.

Users request IMAP access under Mailbox & Account → Third-party clients. Administrators review requests at `/admin?tab=imapAccess`; approval never happens automatically. Approved users can create up to five named client passwords, shown once and stored only as hashes. The website password cannot authenticate IMAP. Revoking a client password, disabling IMAP, or deleting its mailbox invalidates the corresponding client sessions; data requests recheck authorization and idle connections are checked every 60 seconds. Reapproval does not restore revoked passwords.

The TLS IMAP gateway runs separately from Workers. Its randomized hostname is configured in the `IMAP_HOST` Worker secret and disclosed in the approved user's account panel. Clients use port 993, SSL/TLS, their complete mailbox address and a generated client password. The selected deployment uses DNS-only routing, so its DNS record reveals the server address. Random naming reduces casual discovery but is not an authentication mechanism. The website uses mailbox credentials directly; only the IMAP bridge retains Access service authentication.

The gateway supports INBOX and SENT, MIME messages and attachments, search, stable UIDs, IDLE polling, flags, and expunging messages marked Deleted when mailbox deletion is enabled. Expunge permanently removes the corresponding webmail message. Webmail's existing local read/star indicators are separate from IMAP flags. Custom folders and uploading/copying messages are not implemented. SMTP submission uses port 465 with implicit TLS, the same hostname and client password, plus independently approved sender permission and quota. Metadata snapshots are limited to 100,000 messages per folder and a gateway API response to 16 MiB. See [gateway operations](imap_gateway/README.md).

`db/2026-10-29-imap.sql` advances the schema to v0.0.7 with additive permission, credential and UID/flag tables and synchronization triggers. It is repeatable and preserves existing mail. Apply it before deploying the new API. The `/imap_api/*` namespace has a separate Access Service Auth application/audience plus a gateway secret; its signed IMAP sessions use a separate signing key and cannot grant webmail/admin access.

## Security boundary

The canonical domain is public. Pages forwards APIs through its BACKEND service binding; workers.dev and preview URLs are disabled. Mailbox APIs validate signed credentials and confirm that the mailbox still exists. Admin APIs always require the existing admin secret or a signed role checked against the live role table. The setting to disable admin checks no longer bypasses authentication. Anonymous users cannot read mail or generate invitations. IMAP bridge requests still require their separately verified Access audience and gateway credential.

Registration requires a 128-bit random one-use invitation, generated only under `/admin?tab=invitations` (1–100 per batch, configurable 1–365 day validity). Only SHA-256 invitation hashes are stored. Consumption and mailbox creation share one D1 transaction, including rollback on duplicate addresses. Legacy user self-registration, verification-code sending, Telegram HTTP routes, external sending and address transfer are disabled at the public boundary; OAuth login is restricted to existing accounts. Existing user-center sign-in remains available.

Public traffic and authentication attempts have independent rate limits. Cross-origin writes are rejected; mailbox ownership checks protect attachments. Web sends reserve quota atomically and reuse a provider idempotency key on uncertain retries. Definite provider rejection refunds once. Executable attachment extensions are blocked, but this is not antivirus scanning. Web attachments are streamed from the private Oracle store into the provider request as Base64 content. Sending no longer relies on the provider downloading a public attachment URL. The older attachment-only capabilities expire after 24 hours.

HTML mail and sent-mail previews use DOMPurify and an opaque sandbox iframe without scripts, forms or same-origin permission. External images are blocked until explicitly enabled for the current message. Safe links open separately with no referrer. Security response headers apply to function responses as well as HTML: no-store, CSP, HSTS, framing denial, nosniff and restricted device permissions. No external fonts or runtime CDN modules are needed.

The existing admin password values are retained, moved from a visible JSON variable to the `ADMIN_PASSWORDS_SECRET` encrypted Worker secret. The legacy `ADMIN_PASSWORDS` variable is removed by production deployment. Admin/site credential comparisons use Web Crypto HMAC verification. Admin access additionally requires the existing admin credential; No client-provided Access identity header grants administrator privileges. Browser credentials are tab-scoped and credential query parameters are removed from the URL after import. Login, send, creation and admin requests use a bound rate limiter. JSON request bodies are bounded to 2 MiB. Authenticated attachment uploads are streamed with a required Content-Length capped at 25 MiB; the Oracle origin independently enforces that bound. Errors no longer expose internal exception details. No credentials are committed.

## Build and deploy

Use Node 22 and pnpm 10.10.0 and a modern browser with ES2022 support. Production uses `worker/wrangler.production.jsonc` and `pages/wrangler.toml`; Pages requires its default configuration filename.

```sh
pnpm --dir worker install --frozen-lockfile
pnpm --dir frontend install --frozen-lockfile
node --test checks/*.test.mjs
python -m pip install -r imap_gateway/requirements.txt
python checks/imap_protocol_test.py
python checks/smtp_protocol_test.py
pnpm --dir worker lint
pnpm --dir worker exec wrangler deploy --config wrangler.production.jsonc --dry-run --outdir dist --minify
pnpm --dir frontend build:pages
pnpm --dir worker exec wrangler deploy --config wrangler.production.jsonc --minify
cd pages
../frontend/node_modules/.bin/wrangler pages deploy ../frontend/dist --project-name frontend --branch main
```

The **IONACS Mail checks and deployment** workflow checks pushes and pull requests. Its manual `deploy` input uses existing repository Cloudflare secrets. Automatic upstream synchronization is disabled; review upstream changes before syncing this customized fork. Do not use the upstream deployment workflows with old `BACKEND_TOML` / `PAGE_TOML` secrets.

The additive October 2026 database migration adds `raw_mails.metadata` and `address.source_meta`. It has been applied to the production database. Do not reapply it blindly; inspect `PRAGMA table_info` first. A Time Travel bookmark was saved locally before migration. No existing mail/address rows were deleted. Worker rollback does not undo database changes.

## Verification

The security tests exercise signed JWTs, expiry, wrong issuer/audience, unknown keys, signature forgery, algorithm substitution, cross-origin writes, admin comparisons and response headers. Local UI fixtures in `checks/preview-api.mjs` support login, search, reading and simulated delivery success/failure without sending real mail; they are never deployed. Production checks may use isolated disposable fixtures for authorized registration, attachment and permission verification. Do not send external test emails unless actual delivery is explicitly requested.

Production dependencies were refreshed within compatible versions. The frontend production audit has no known findings. The backend high/critical findings were fixed; residual advisories concern the older optional passkey stack and a transitive UUID API. These are documented limitations, not a claim of complete security certification. A future passkey major-version migration should include credential compatibility testing.

IMAP verification covers permission ownership, request idempotency, credential revocation, password migration, UID stability, MIME retrieval and real TLS client commands. A synthetic isolated mailbox was also used for the deployed gateway check and removed afterwards; no external message delivery was used. Deployment checks are not a claim of certification with every desktop/mobile client. CI tests the gateway, but deploying its server files and rotating its Access service token are separate operator tasks.

## SMTP submission

The gateway accepts authenticated SMTP on 465 only; it exposes no plaintext relay or port 25. PLAIN and LOGIN authentication occur inside TLS. Envelope and MIME From addresses must match the authenticated mailbox. Submission uses the existing Resend credentials through the private Worker API, preserving text/HTML, attachments and inline content IDs. To/Cc/Bcc delivery comes from accepted SMTP envelope recipients; at least one To recipient is required. The total raw message limit is 1 MiB and recipient limit 20. Each envelope recipient consumes one unit of the existing sender quota; webmail also charges one unit per unique To/Cc/Bcc recipient.

The additive `db/2026-10-29-smtp.sql` migration advances the schema to v0.0.8. A trigger atomically reserves quota on first submission; identical MIME and recipient lists share an idempotency key. Definite provider rejection refunds the reservation once. Uncertain responses retain it and return SMTP 451 so clients can retry; retries reuse the provider key without charging again. An unresolved attempt older than 23 hours is held for operator review instead of risking duplicate delivery. Sent archives store the original MIME and are visible in webmail/IMAP; disable redundant client-side Sent uploads because IMAP APPEND is unsupported. Metadata for submission deduplication is retained until mailbox deletion.

SMTP tests use a synthetic provider: they cover TLS authentication, relay/sender restrictions, multi-recipient MIME, failed delivery responses, quotas, retry idempotency and archival. Public deployment checks verify TLS, authentication and denied sending with an isolated unapproved fixture. No real external delivery is performed automatically.

The deployment also exposes an implicit-TLS SMTP fallback on 2465 (`SMTP_ALT_PORT`) for networks that cannot connect to 465. Both listeners share authentication/connection limits and the same certificate. Set the alternate port in both the Worker and gateway environment; no plaintext/STARTTLS listener is provided.


## November 2026 public-mail deployment

Apply `db/2026-11-02-public-mail.sql` before deploying the API (additive, repeatable, schema v0.0.9). Initialization and the admin migration workflow also include these tables. A pre-change D1 Time Travel bookmark and prior Access/Tunnel settings are saved in ignored `.private/` files. The TP-Auth Access application keeps its other protected sites; only `mail.ionacs.com` and legacy `m.ionacs.com` were removed. The separate `/imap_api/*` application remains intact.

Attachment storage runs as `ionacs-mail-storage.service` on the existing status Oracle host `168.107.53.146`, bound to loopback port 8091. `/mail-storage/*` on status.ionacs.com is routed by the existing Cloudflare Tunnel. Every operation requires a server-only random bearer secret, loaded with systemd LoadCredential and stored in the Worker secret `ATTACHMENT_SECRET`. No attachment content or credential is returned by the public health check. The service uses streamed files, atomic writes, a 10 GiB global quota, a 1 GiB free-disk reserve, four concurrent connections, 128 MiB memory and 35% CPU cap. Mailbox storage is capped at 500 MiB and 40 pending uploads. An hourly Worker cron removes expired drafts and files owned by deleted mailboxes. Oracle attachment data is a single-host store, not a replicated archive; the existing Cloudflare/D1 mail data remains separate. Existing third-party SMTP/IMAP message-size constraints are unchanged by this web-composer release.

The existing status application on this same Oracle host monitors the mail webpage, public settings API and end-to-end attachment health every two minutes. Redirects, challenge pages and stale probe results are treated as unavailable. The markets Oracle host is not used. No external test email is sent during deployment verification.

Verification includes unit and route-level tests for invitation reuse/rollback, administrator separation, malformed/oversized/cross-mailbox attachments, Cc/Bcc, quota exhaustion, provider failures and idempotent archival, plus browser layout/editor checks. Dependency audit on 2026-11-02 found zero frontend production advisories and zero high/critical backend advisories. Backend residuals: one moderate uuid buffer-bound advisory and low SimpleWebAuthn trust-anchor/deepmerge advisories. The Telegram HTTP surface is disabled, passkey origins/RP IDs are fixed to mail.ionacs.com, and upgrading the optional passkey stack remains separate compatibility work. Tests and scanning do not guarantee absence of unknown vulnerabilities.

Production boundary verification passed on 2026-11-02: a full 25 MiB file uploaded/downloaded with a matching SHA-256, a second mailbox was denied access, 25 MiB plus one byte was rejected before provider submission, and reused invitations/ordinary-mailbox admin access were rejected. Synthetic mailboxes, invitation records and files were removed afterwards.

### Attachment delivery repair (2026-11-02)

A live Resend failure reported inaccessible attachment URLs after API acceptance. Web sends now stream bounded Base64 chunks into a fixed-length provider request, preserving the 25 MiB aggregate limit without buffering the whole request. Sent archives retain a submission identifier; the owner can query provider delivery status and reopen failed mail in the composer. API acceptance is distinguished from recipient-server acceptance. The administrator status endpoint returns metadata only and never returns message bodies or credentials.
