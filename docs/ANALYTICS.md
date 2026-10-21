# Owner dashboard

The private page that answers "how many people came, from where, on what, and is
the site up" without adding an analytics vendor.

```
https://voxbridge-mic.vercel.app/dashboard
```

It is not linked from any page, carries `noindex, nofollow`, and is disallowed in
`robots.txt`. Being hard to find is not the security model — the data itself is
unreadable without the owner key.

## How access works

| Piece | Where it lives | Notes |
| --- | --- | --- |
| Owner key | Only in your browser (`localStorage`, key `voxbridge-owner-key`) | Generated once by the database owner, shown once. Never in the repository. |
| Key hash | `public.owner_access.key_sha256` | Single row (`id = 1`), `pgcrypto` SHA-256. The plaintext never reaches the database. |
| Verification | `public.owner_guard(text)` | `security definer`; raises `42501` for a wrong key. |
| Rate limit | `public.owner_auth_failures` | 30 failures in 10 minutes blocks any attempt until the window passes. Rows older than an hour are pruned on each successful call. |
| Rotation | `public.owner_rotate(old, new)` | New key must be ≥ 24 characters. Clears the failure log. |

Every read goes through one of five functions, all of which call `owner_guard`
first:

| Function | Returns |
| --- | --- |
| `owner_ping(key)` | `{ok: true}` — used to unlock the page |
| `owner_live(key)` | People on site now (5 min), 15-minute visitors/views/downloads, today's totals, a 60-minute pulse, and the 30 most recent events |
| `owner_traffic(key, days, tz)` | Totals, a per-day series, and breakdowns by page, referrer, country, device, browser, campaign, platform, source, download country and download device |
| `owner_health(key, days, tz)` | Recorded probes plus a daily rollup (runs, passes, average latency) |
| `owner_messages(key, limit)` | Feedback and release-note submissions, newest first |

`anon` may execute those five functions and nothing else. `page_events`,
`download_events`, `feedback`, `health_checks`, `owner_access` and
`owner_auth_failures` are insert-only (or fully closed) for `anon`, so the public
key shipped in `config.js` cannot read a single row. The release smoke test
asserts exactly that on every run.

### If the key is lost

Rotate it from the dashboard while it still works. If it is lost entirely, set a
new hash with the Supabase SQL editor — never store the plaintext there:

```sql
update public.owner_access
   set key_sha256 = encode(digest('the-new-key-at-least-24-chars', 'sha256'), 'hex'),
       updated_at = now()
 where id = 1;
```

## What is recorded

Anonymous, aggregated, no cookie and no IP address.

| Table | Columns | Written by |
| --- | --- | --- |
| `page_events` | `view_id` (random per page load), `path`, `referrer` (host), `campaign` (`utm_*`), `device`, `os`, `browser`, `country`, `created_at` | `assets/js/site.js`, one beacon per page load |
| `download_events` | `platform`, `version`, `source`, `referrer`, `campaign`, `device`, `os`, `browser`, `country`, `created_at` | `site.js` on a download click; smoke test with `source = 'smoke-test'` |
| `feedback` | `email`, `topic`, `message`, `platform`, `app_version`, `created_at` | the support form |
| `health_checks` | `ok`, `latency_ms`, `checks` (jsonb per endpoint), `source`, `checked_at` | `.github/workflows/health.yml`, `scripts/health-probe.js` |

`device`, `os` and `browser` are coarse buckets derived from the user agent
(`Phone`/`Tablet`/`Desktop`, `Windows`/`Android`/`iOS`/`macOS`/`Linux`, and the
browser family, with common in-app browsers named). `country` is a two-letter
code inferred from the browser's IANA timezone — no IP geolocation, no precise
location. The privacy policy says the same thing in §4.

Rows whose `source` or `topic` is `smoke-test` are filtered out of the dashboard,
so CI runs never look like users.

## Health checks

`scripts/health-probe.js` fetches the home page, the download page, the
dashboard, the download manifest and both Windows/Android files from the live
host, records each result, and writes one row. `.github/workflows/health.yml`
runs it every 15 minutes; the smoke test runs it once per release. If the site is
down the row says so — the workflow only fails when the row itself cannot be
written.

The dashboard also has a **Run test** button that probes the same endpoints from
the browser, for the moment you want to know rather than the last scheduled tick.

## Local development

The dashboard is a static page; nothing needs a build step.

```bash
cd apps/web
python3 -m http.server 8080
# open http://localhost:8080/dashboard.html and paste the key
```

The browser hits Supabase directly, exactly as production does.
