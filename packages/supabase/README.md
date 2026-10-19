# Supabase

The website uses two write-only tables and one aggregate function. There is no
authentication: the publishable (anon) key can insert rows and read the
aggregate, nothing else. Row level security is enabled on both tables and the
only policies are `insert`.

| Object | Purpose |
|---|---|
| `public.download_events` | One row per download click: `platform`, `version`, `source`, `created_at` |
| `public.feedback` | Support and newsletter messages: `email`, `topic`, `message`, `platform`, `app_version` |
| `public.download_counts()` | `security definer` aggregate returning `(platform, count)` |

Apply the migration with the Supabase CLI:

```bash
supabase link --project-ref <ref>
supabase db push
```

Or paste `migrations/0001_init.sql` into the SQL editor.

Client configuration lives in `apps/web/assets/js/config.js`. Only the
publishable key belongs there; service keys must never reach the browser.
