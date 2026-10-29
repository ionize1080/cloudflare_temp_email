# IONACS Mail

Production: https://mail.ionacs.com. The former `m.ionacs.com` address and Pages preview hostnames redirect to the canonical origin. Existing mail domains (`ionacs.com`, `ioaaz.com`), D1 data, KV, Resend credentials and Cloudflare Access policies are retained.

## Experience

Gmail-inspired, responsive Vue mailbox with a search bar, folder navigation, selection, read indicators, local stars, full-message reading, attachments, reply/forward, a floating/minimizable composer, session drafts, dark mode and keyboard shortcuts (`/` search, `c` compose, Ctrl/Command+Enter send). IONACS branding is independent of Google.

Search is scoped to the selected folder and searches stored raw content/sender fields. MIME-encoded words may not match their decoded equivalents. Stars and read indicators are stored on this device, not synchronized. Drafts are scoped to the selected mailbox in sessionStorage; closing the browser session or logging out clears them. The new composer sends plain text; existing rich-text administrative tools remain available. There is no pretend Trash folder: deletion requires explicit confirmation and is permanent, matching the existing API.

## Security boundary

The existing TP-Auth Access application protects the canonical domain. Both Pages middleware and the API Worker verify the RS256 signature, fixed issuer, fixed audience, expiry and not-before claim. Missing/invalid assertions fail closed, including on workers.dev. Pages forwards API requests over the `BACKEND` service binding. Public email delivery uses the Worker's separate `email()` handler and remains unaffected. Programmatic HTTP clients now need an authorized Access assertion in addition to their existing mailbox/admin credentials.

HTML mail and sent-mail previews use DOMPurify and an opaque sandbox iframe without scripts, forms or same-origin permission. External images are blocked until explicitly enabled for the current message. Safe links open separately with no referrer. Security response headers apply to function responses as well as HTML: no-store, CSP, HSTS, framing denial, nosniff and restricted device permissions. No external fonts or runtime CDN modules are needed.

The existing admin password values are retained, moved from a visible JSON variable to the `ADMIN_PASSWORDS_SECRET` encrypted Worker secret. The legacy `ADMIN_PASSWORDS` variable is removed by production deployment. Admin/site credential comparisons use Web Crypto HMAC verification. Admin access additionally requires the existing admin credential; Access alone does not confer mailbox administrator privileges. Browser credentials are tab-scoped and credential query parameters are removed from the URL after import. Login, send, creation and admin requests use a bound rate limiter. Request bodies are bounded to 2 MiB. Errors no longer expose internal exception details. No credentials are committed.

## Build and deploy

Use Node 22 and pnpm 10.10.0 and a modern browser with ES2022 support. Production uses `worker/wrangler.production.jsonc` and `pages/wrangler.toml`; Pages requires its default configuration filename.

```sh
pnpm --dir worker install --frozen-lockfile
pnpm --dir frontend install --frozen-lockfile
node --test checks/security.test.mjs
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
