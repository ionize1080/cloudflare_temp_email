# IONACS Mail

Production: https://mail.ionacs.com. The former `m.ionacs.com` address and Pages preview hostnames redirect to the canonical origin. Existing mail domains (`ionacs.com`, `ioaaz.com`), D1 data, KV, Resend credentials and Cloudflare Access policies are retained.

## Experience

Gmail-inspired, responsive Vue mailbox with a search bar, folder navigation, selection, read indicators, local stars, full-message reading, attachments, reply/forward, a floating/minimizable composer, session drafts, dark mode and keyboard shortcuts (`/` search, `c` compose, Ctrl/Command+Enter send). IONACS branding is independent of Google.

Search is scoped to the selected folder and searches stored raw content/sender fields. MIME-encoded words may not match their decoded equivalents. Stars and read indicators are stored on this device, not synchronized. Drafts are scoped to the selected mailbox in sessionStorage; closing the browser session or logging out clears them. The new composer sends plain text; existing rich-text administrative tools remain available. There is no pretend Trash folder: deletion requires explicit confirmation and is permanent, matching the existing API.

## Administration and sending requests

The Gmail-inspired admin workspace at `/admin` has a searchable sidebar, overview, sender approvals, mailbox/user management, security status, and operation history. Existing advanced settings remain under More Features and load on demand. Direct links such as `/admin?tab=senderAccess`, `/admin?tab=user_settings`, and `/admin?tab=security` open the appropriate section.

Mailbox users request permission from the compose window or mailbox/account panel. Requests always await administrator review; this fork does not automatically grant `DEFAULT_SEND_BALANCE`. Duplicate requests are idempotent and cannot reset existing quotas. Exhausted or disabled mailboxes can request review again. Administrators can review a pending request or configure an existing mailbox directly, choose whether sending is enabled, and set the remaining total quota (integer 0–100000). A successful change writes an internal notification; the user can click Refresh Status in the composer. Existing approved quotas are preserved.

The additive `db/2026-10-29-admin-console.sql` migration adds `address_sender.requested_at` and `admin_audit`, advancing the schema to v0.0.6. It has been applied to production after saving a Time Travel bookmark. Do not reapply its ALTER statement; the admin database migration checks column presence. Legacy disabled entries without a pending timestamp can still be managed from All or requested again by their owners.

Audit history records the verified Access identity, method, path (without query string), HTTP result and UTC time for authorized admin mutations and credential reads. It begins with this release and retains the latest 1000 records. Passwords, tokens, bodies and mail contents are not logged. Audit writes run with `waitUntil`; failures emit a structured error. This is operational history, not a tamper-proof compliance log. The admin page clears its cached management password after 15 idle minutes; this does not revoke the independently managed Access session. A manual lock and Access logout are also available.

Mailbox deletion now removes related records before the address in a single D1 transaction, preventing orphaned mail/permission records and partial cleanup. No production deletions were used for validation. Immediate maintenance cleanup requires typing an explicit confirmation.

## Password accounts and IMAP clients

The mailbox login now accepts a full email address and password. New mailboxes choose a 12–128 character password during registration; an existing mailbox session can set or change its password in Mailbox & Account. Existing credential login remains available for migration. Passwords use individual random salts and PBKDF2-SHA256 (100,000 iterations, the Workers Web Crypto limit). Legacy password hashes are upgraded on successful login. Changing a mailbox password revokes its IMAP client passwords; it does not invalidate already-issued web mailbox JWTs or the separate Cloudflare Access session.

Users request IMAP access under Mailbox & Account → Third-party clients. Administrators review requests at `/admin?tab=imapAccess`; approval never happens automatically. Approved users can create up to five named client passwords, shown once and stored only as hashes. The website password cannot authenticate IMAP. Revoking a client password, disabling IMAP, or deleting its mailbox invalidates the corresponding client sessions; data requests recheck authorization and idle connections are checked every 60 seconds. Reapproval does not restore revoked passwords.

The TLS IMAP gateway runs separately from Workers. Its randomized hostname is configured in the `IMAP_HOST` Worker secret and disclosed in the approved user's account panel. Clients use port 993, SSL/TLS, their complete mailbox address and a generated client password. The selected deployment uses DNS-only routing, so its DNS record reveals the server address. Random naming reduces casual discovery but is not an authentication mechanism. The website continues through the original Cloudflare Access application.

The gateway supports INBOX and SENT, MIME messages and attachments, search, stable UIDs, IDLE polling, flags, and expunging messages marked Deleted when mailbox deletion is enabled. Expunge permanently removes the corresponding webmail message. Webmail's existing local read/star indicators are separate from IMAP flags. Custom folders and uploading/copying messages are not implemented. SMTP submission uses port 465 with implicit TLS, the same hostname and client password, plus independently approved sender permission and quota. Metadata snapshots are limited to 100,000 messages per folder and a gateway API response to 16 MiB. See [gateway operations](imap_gateway/README.md).

`db/2026-10-29-imap.sql` advances the schema to v0.0.7 with additive permission, credential and UID/flag tables and synchronization triggers. It is repeatable and preserves existing mail. Apply it before deploying the new API. The `/imap_api/*` namespace has a separate Access Service Auth application/audience plus a gateway secret; its signed IMAP sessions use a separate signing key and cannot grant webmail/admin access.

## Security boundary

The existing TP-Auth Access application protects the canonical domain. Both Pages middleware and the API Worker verify the RS256 signature, fixed issuer, fixed audience, expiry and not-before claim. Missing/invalid assertions fail closed, including on workers.dev. Pages forwards API requests over the `BACKEND` service binding. Public email delivery uses the Worker's separate `email()` handler and remains unaffected. Programmatic HTTP clients now need an authorized Access assertion in addition to their existing mailbox/admin credentials.

HTML mail and sent-mail previews use DOMPurify and an opaque sandbox iframe without scripts, forms or same-origin permission. External images are blocked until explicitly enabled for the current message. Safe links open separately with no referrer. Security response headers apply to function responses as well as HTML: no-store, CSP, HSTS, framing denial, nosniff and restricted device permissions. No external fonts or runtime CDN modules are needed.

The existing admin password values are retained, moved from a visible JSON variable to the `ADMIN_PASSWORDS_SECRET` encrypted Worker secret. The legacy `ADMIN_PASSWORDS` variable is removed by production deployment. Admin/site credential comparisons use Web Crypto HMAC verification. Admin access additionally requires the existing admin credential; Access alone does not confer mailbox administrator privileges. Browser credentials are tab-scoped and credential query parameters are removed from the URL after import. Login, send, creation and admin requests use a bound rate limiter. Request bodies are bounded to 2 MiB. Errors no longer expose internal exception details. No credentials are committed.

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

The security tests exercise signed JWTs, expiry, wrong issuer/audience, unknown keys, signature forgery, algorithm substitution, cross-origin writes, admin comparisons and response headers. Local UI fixtures in `checks/preview-api.mjs` support login, search, reading and simulated delivery success/failure without sending real mail; they are never deployed. Production smoke tests should be read-only unless actual email delivery is explicitly requested.

Production dependencies were refreshed within compatible versions. The frontend production audit has no known findings. The backend high/critical findings were fixed; residual advisories concern the older optional passkey stack and a transitive UUID API. These are documented limitations, not a claim of complete security certification. A future passkey major-version migration should include credential compatibility testing.

IMAP verification covers permission ownership, request idempotency, credential revocation, password migration, UID stability, MIME retrieval and real TLS client commands. A synthetic isolated mailbox was also used for the deployed gateway check and removed afterwards; no external message delivery was used. Deployment checks are not a claim of certification with every desktop/mobile client. CI tests the gateway, but deploying its server files and rotating its Access service token are separate operator tasks.

## SMTP submission

The gateway accepts authenticated SMTP on 465 only; it exposes no plaintext relay or port 25. PLAIN and LOGIN authentication occur inside TLS. Envelope and MIME From addresses must match the authenticated mailbox. Submission uses the existing Resend credentials through the private Worker API, preserving text/HTML, attachments and inline content IDs. To/Cc/Bcc delivery comes from accepted SMTP envelope recipients; at least one To recipient is required. The total raw message limit is 1 MiB and recipient limit 20. Each envelope recipient consumes one unit of the existing sender quota; webmail continues using its existing one-recipient send flow.

The additive `db/2026-10-29-smtp.sql` migration advances the schema to v0.0.8. A trigger atomically reserves quota on first submission; identical MIME and recipient lists share an idempotency key. Definite provider rejection refunds the reservation once. Uncertain responses retain it and return SMTP 451 so clients can retry; retries reuse the provider key without charging again. An unresolved attempt older than 23 hours is held for operator review instead of risking duplicate delivery. Sent archives store the original MIME and are visible in webmail/IMAP; disable redundant client-side Sent uploads because IMAP APPEND is unsupported. Metadata for submission deduplication is retained until mailbox deletion.

SMTP tests use a synthetic provider: they cover TLS authentication, relay/sender restrictions, multi-recipient MIME, failed delivery responses, quotas, retry idempotency and archival. Public deployment checks verify TLS, authentication and denied sending with an isolated unapproved fixture. No real external delivery is performed automatically.

The deployment also exposes an implicit-TLS SMTP fallback on 2465 (`SMTP_ALT_PORT`) for networks that cannot connect to 465. Both listeners share authentication/connection limits and the same certificate. Set the alternate port in both the Worker and gateway environment; no plaintext/STARTTLS listener is provided.
