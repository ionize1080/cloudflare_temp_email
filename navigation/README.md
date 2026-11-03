# IONACS Navigation

Chrome-new-tab-inspired navigation at `https://ionacs.com`, published independently from the existing mailbox application. The source stays in this repository to share the mailbox password implementation and deploy through Cloudflare Workers Builds.

## Behavior

- Guests see a white background and search/default shortcuts. They never request wallpaper metadata or images. Wallpaper endpoints require login.
- Existing mailbox addresses and passwords sign in directly. `adrian@ionacs.com` is the only navigation administrator. Its existing password is never changed or seeded. The administrator mailbox must already exist and have a password.
- New navigation registrations require an administrator-generated invitation and create a real `@ionacs.com` mailbox. A D1 transaction and trigger atomically create the mailbox and consume invitation capacity. Reserved administrative names cannot be registered.
- Webmail is publicly reachable without Cloudflare Access; passwords, Turnstile, invitation registration and application authorization remain mandatory. Navigation deployments do not change mailbox routing or security settings.
- Passwords use the mailbox's shared PBKDF2 implementation. Session cookies are Secure, HttpOnly, SameSite=Lax, host-only, use a persistent 400-day cookie renewed after a day of activity, and are revoked when the mailbox password changes. No credentials go to browser storage.
- First use keeps the same five shortcuts as the guest page: IONACS Mail, Google, GitHub, YouTube and Bing. Initialization is atomic and recorded separately, so existing collections stay intact and deleting every shortcut does not restore defaults. Bookmarks support create/edit/delete, up to 100 per user. Preferences and bookmarks are scoped by authenticated mailbox ID.
- Auth requests require real server-side Turnstile validation, exact hostname/action checks, and IP/account rate limits. No production test mode or default administrator password exists.

## Wallpaper cache

Source: [niumoo/bing-wallpaper](https://github.com/niumoo/bing-wallpaper), specifically the maintained `bing-wallpaper.md` listing. Its older `docs/images.json` is not used. Descriptions and copyright attribution are retained.

The latest seven days of metadata live in `nav_wallpapers` in Cloudflare D1. Desktop (1920×1080) and thumbnail (480×270) image bytes live in the existing KV namespace with a dedicated `nav-wallpaper:` prefix and 14-day expiry. Images are served from the same authenticated origin, with private browser caching. Images are not stored as large database rows. Deployment warms the cache; a Worker cron checks every six hours. Login reads existing cache immediately and schedules stale refresh in the background. Upstream failures preserve existing cached metadata. A fixed wallpaper remains linked to its original Bing image after it leaves the seven-day cache.

## Development and verification

Node 22; `npm ci`, `npm run check`, `npm test`, `npm run build`. Tests use an isolated local D1 database and synthetic users, checking invitation race conditions, mailbox password compatibility, session invalidation, cross-user data access, CSRF, URL validation, Turnstile hostname/action checks, and guest wallpaper denial.

`npm run dev` serves the app locally; real login intentionally fails without configured Turnstile. Tests mock external verification in the test process only. Never place test keys or fixtures in a production environment.

## Automatic publication

Cloudflare Workers Builds watches `main` in this repository, rooted at `navigation`. It runs navigation and mailbox checks, builds and dependency auditing before `npm run deploy`. Only the navigation Worker publishes. Mailbox API and Pages releases are handled separately to prevent an older navigation checkout from overwriting mailbox security fixes. The GitHub `IONACS Navigation checks` workflow also verifies pushes and pull requests. Build initialization uses the existing Cloudflare build identity. Publishing uses a dedicated account token stored as the encrypted `NAV_DEPLOY_TOKEN` build secret, independent of the repository's old deployment secrets.

Deployment applies only additive navigation migrations via the separate `nav_migrations` table, warms wallpaper cache, prepares a managed Turnstile widget, uploads its secret, and attaches the root domain using Cloudflare Worker Custom Domains. Existing mailbox routing and email records are not edited.

The account ID comes from the navigation Wrangler configuration. The build token has Workers Scripts, Cloudflare Pages, D1, Workers KV and Turnstile write permissions for that account, plus Workers Routes write and Zone read permissions for ionacs.com. The Turnstile secret is deployed atomically with the Worker using a private temporary file (0600), removed in `finally`; deployment tokens stay in memory/environment. Secrets are never committed. DNS/Access conflicts fail deployment rather than disabling protections.

Inspect Workers Builds results and the public health check to verify publication. To roll back, revert a navigation commit and let Workers Builds deploy the previous code. Additive navigation tables are retained; no mail records are dropped.

## Product directory and icons

The add/edit dialog searches a curated directory of 140 common products and news publications locally, using Chinese/English names, domains, aliases and company names. This is a useful directory, not a claimed traffic ranking. Product-specific domains and paths distinguish YouTube, Gmail, Maps, Docs, Sheets and Slides; selecting a suggestion fills editable name/URL fields. Keyboard navigation supports arrows, Enter and Escape.

Core marks and controls are local SVG vectors. Other product favicons are bundled in `public/site-icons`, obtained from the public Google favicon service (with DuckDuckGo/site favicon fallbacks) on 2026-11-03. Logos belong to their respective owners. Searches use the local directory. Curated marks remain bundled; dynamic icons are fetched through the authenticated icon endpoint.

## Persistent login and mailbox handoff

Navigation uses a 400-day persistent cookie (the browser maximum), renewed on authenticated activity, with server-side revocation on logout and password changes. Browser storage clearing or very long inactivity can still require signing in again.

Opening the mailbox from navigation creates a five-minute, single-use handoff. The mail frontend removes the fragment immediately and exchanges it over a same-origin POST. The receiver issues a separate Secure/HttpOnly host-only mailbox cookie, default 24 hours, configurable as 1, 8, 24 or 168 hours in navigation preferences. Mail authentication checks the source navigation session and password version. The mailbox cookie also carries a revocable mailbox authentication version; Cloudflare Access is not required for webmail.


## Website icons and shortcut navigation (2026-11-03)

The directory now includes 40 international and Chinese-language news outlets, searchable by name, alias and domain. Saved shortcuts open a new tab with `noopener noreferrer`; the mailbox handoff remains single-use and also opens a separate tab. Popup blocking leaves the navigation page intact.

Unlisted websites and newly added news outlets fetch icons when rendered after saving. The service visits the public homepage (never a saved path, query or fragment), parses declared icons and falls back to `/favicon.ico`. Existing curated product marks are retained. Editing a saved dynamic-icon shortcut exposes **刷新图标**; unsaved URL changes must be saved first.

Icon bytes are cached per account/origin in the existing KV namespace using `nav-site-icon:` keys: seven-day freshness, 28-day retention, five-minute failure backoff, and a 60-second manual-refresh cooldown. A successful refresh returns the new image immediately to avoid waiting for KV replication. Fetch failures retain the previous image. Authentication, bookmark ownership, same-origin refresh and per-account rate limits apply.

Upstream fetches carry no user credentials, follow only bounded manually validated redirects, reject literal/private/reserved destinations and private DNS answers, and cap image size at 256 KiB and total fetch time at 12 seconds. HTML parsing is capped at 512 KiB. PNG/JPEG/GIF/WebP/ICO are identified by file signatures; active HTML/XML/SVG responses are rejected. A site that blocks requests or only publishes an unsupported image format may retain its fallback icon. DNS preflight is defense in depth and does not pin the subsequent Cloudflare fetch to a DNS answer; this Worker has no private-network service bindings.

Validation: 33 automated tests, including actual Workers runtime fetch semantics, cached/manual refresh, failed refresh retention, redirect/DNS rejection, response limits, account isolation, CSRF and rate limits. Browser checks use an isolated local database and synthetic account; no production mailbox or user bookmarks are changed by those checks.
