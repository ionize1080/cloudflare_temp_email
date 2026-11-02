# IONACS Navigation

Chrome-new-tab-inspired navigation at `https://ionacs.com`, published independently from the existing mailbox application. The source stays in this repository to share the mailbox password implementation and existing deployment secrets.

## Behavior

- Guests see a white background and search/default shortcuts. They never request wallpaper metadata or images. Wallpaper endpoints require login.
- Existing mailbox addresses and passwords sign in directly. `adrian@ionacs.com` is the only navigation administrator. Its existing password is never changed or seeded. The administrator mailbox must already exist and have a password.
- New navigation registrations require an administrator-generated invitation and create a real `@ionacs.com` mailbox. A D1 transaction and trigger atomically create the mailbox and consume invitation capacity. Reserved administrative names cannot be registered.
- This does not modify the existing mail website's independent Cloudflare Access policies or its registration settings. Opening webmail still requires its existing Access authorization. Invitation enforcement here applies to navigation registration, not a global migration of existing mail registration policy.
- Passwords use the mailbox's shared PBKDF2 implementation. Session cookies are Secure, HttpOnly, SameSite=Lax, host-only, expire after seven days, and are revoked when the mailbox password changes. No credentials go to browser storage.
- Bookmarks support create/edit/delete, up to 100 per user. Preferences and bookmarks are scoped by authenticated mailbox ID.
- Auth requests require real server-side Turnstile validation, exact hostname/action checks, and IP/account rate limits. No production test mode or default administrator password exists.

## Wallpaper cache

Source: [niumoo/bing-wallpaper](https://github.com/niumoo/bing-wallpaper), specifically the maintained `bing-wallpaper.md` listing. Its older `docs/images.json` is not used. Descriptions and copyright attribution are retained.

The latest seven days of metadata live in `nav_wallpapers` in Cloudflare D1. Desktop (1920×1080) and thumbnail (480×270) image bytes live in the existing KV namespace with a dedicated `nav-wallpaper:` prefix and 14-day expiry. Images are served from the same authenticated origin, with private browser caching. Images are not stored as large database rows. Deployment warms the cache; a Worker cron checks every six hours. Login reads existing cache immediately and schedules stale refresh in the background. Upstream failures preserve existing cached metadata. A fixed wallpaper remains linked to its original Bing image after it leaves the seven-day cache.

## Development and verification

Node 22; `npm ci`, `npm run check`, `npm test`, `npm run build`. Tests use an isolated local D1 database and synthetic users, checking invitation race conditions, mailbox password compatibility, session invalidation, cross-user data access, CSRF, URL validation, Turnstile hostname/action checks, and guest wallpaper denial.

`npm run dev` serves the app locally; real login intentionally fails without configured Turnstile. Tests mock external verification in the test process only. Never place test keys or fixtures in a production environment.

## Automatic publication

The `IONACS Navigation deploy` workflow checks changes and automatically deploys successful main-branch changes. It applies only additive navigation migrations via the separate `nav_migrations` table, warms wallpaper cache, prepares a managed Turnstile widget, uploads its secret, and attaches the root domain using Cloudflare Worker Custom Domains. Existing mailbox routing and email records are not edited.

Repository secrets: existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The token needs Workers Scripts edit, D1 edit, Workers KV edit, the applicable domain deployment permissions, and Account Turnstile edit. Alternatively set `TURNSTILE_SITE_KEY` plus `TURNSTILE_SECRET_KEY` for a pre-created managed widget allowing exactly `ionacs.com`. Deployment fails closed if permissions/credentials are missing. Secrets are passed in memory/stdin and never committed. DNS/Access conflicts require review rather than disabling existing protections.

Deployment is not verified merely because the files exist: inspect the workflow result and the public health check. To roll back, revert a navigation commit and let the workflow deploy the previous code. Additive navigation tables are retained; no mail records are dropped.
