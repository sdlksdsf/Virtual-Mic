# A domain for VoxBridge

## The honest answer first

There is no such thing as a **free domain you own**. Registries charge for `something.com`; anything
advertised as "free domain" is one of three things:

1. **A subdomain of somebody else's domain** (`voxbridge.is-a.dev`). Free, real DNS, real HTTPS,
   works with Vercel exactly like a paid domain — but the community that owns the parent domain can
   take it back, and you cannot use it for email.
2. **A dead or hostile TLD** (`.tk`, `.ml`, `.ga`, `.cf`, `.gq`). Freenom stopped taking
   registrations, the zones are unreliable, and browsers and mail servers treat them as spam
   sources. Not worth it.
3. **A first-year promotion** (`.xyz`, `.tech`, `.me` for $1–2, then $15–40/year). Not free.

So: use a free subdomain now, and buy `voxbridge.app` (≈ $12/year, or free for one year with the
GitHub Student Pack if you are a student) when you want email addresses and permanence. Everything
below is built so that swapping one for the other is a single command.

## The options, compared

| Name | Cost | Owned by | Vercel | Approval | Fit for VoxBridge |
|---|---|---|---|---|---|
| **`voxbridge.is-a.dev`** | free | community registry | CNAME + TXT | PR review, hours–days | **Best.** General software projects, non-commercial |
| `voxbridge.js.org` | free | JS.ORG | CNAME | PR review | Likely declined — they now accept only JS-ecosystem projects (npm packages, libraries), not product sites |
| `voxbridge.eu.org` | free | EU.org volunteers | CNAME / own DNS panel | Weeks to months | Good but slow; non-commercial only |
| `voxbridge.openrepos.org` | free | community | CNAME | PR + CI | Open-source only, less known |
| `voxbridge.app` | ≈ $12/yr | you | A / nameservers | instant | The real answer long term |

`is-a.dev` is on the Public Suffix List, so every subdomain is treated as its own site by browsers
and search engines — cookies and reputation do not leak between neighbours. That matters: the free
subdomain will not inherit someone else's spam problems.

## What is already done

`voxbridge.is-a.dev` is **available** (checked against the registry), added to the Vercel project
`voxbridge-app`, and Vercel has issued the two records the registry needs:

| Type | Name | Value |
|---|---|---|
| CNAME | `voxbridge.is-a.dev` | `2e2a0d32b55ea232.vercel-dns-017.com` |
| TXT | `_vercel.voxbridge.is-a.dev` | `vc-domain-verify=voxbridge.is-a.dev,850ac8b550f8ca392136` |

Both files are in this folder, ready to copy:

- [`voxbridge.json`](./voxbridge.json) — the CNAME
- [`_vercel.voxbridge.json`](./_vercel.voxbridge.json) — the verification TXT

## What is left — four clicks

The GitHub token used by automation can read public repositories but **cannot fork a third-party
repository** (403), so this last part has to come from your account. It takes about two minutes.

1. **Fork the registry** — <https://github.com/is-a-dev/register/fork> (keep the name `register`).

2. **Create the first file** — this link opens the file already filled in on your fork. Click
   *Commit changes* (directly on `main` is fine, it is your fork):

   *(if GitHub does not prefill the editor, paste the contents of
   [`voxbridge.json`](./voxbridge.json) by hand — it is five lines)*

   <https://github.com/sdlksdsf/register/new/main/domains?filename=voxbridge.json&value=%7B%0A%20%20%22owner%22%3A%20%7B%0A%20%20%20%20%22username%22%3A%20%22sdlksdsf%22%0A%20%20%7D%2C%0A%20%20%22records%22%3A%20%7B%0A%20%20%20%20%22CNAME%22%3A%20%222e2a0d32b55ea232.vercel-dns-017.com%22%0A%20%20%7D%0A%7D>

3. **Create the second file** — same idea, the verification record:

   <https://github.com/sdlksdsf/register/new/main/domains?filename=_vercel.voxbridge.json&value=%7B%0A%20%20%22owner%22%3A%20%7B%0A%20%20%20%20%22username%22%3A%20%22sdlksdsf%22%0A%20%20%7D%2C%0A%20%20%22records%22%3A%20%7B%0A%20%20%20%20%22TXT%22%3A%20%22vc-domain-verify%3Dvoxbridge.is-a.dev%2C850ac8b550f8ca392136%22%0A%20%20%7D%0A%7D>

4. **Open the pull request** —
   <https://github.com/is-a-dev/register/compare/main...sdlksdsf:register:main>
   Title: `feat(domain): add voxbridge.is-a.dev`
   Body: paste [`pr-body.md`](./pr-body.md) exactly (the template rejects modified comments and
   unchecked boxes). If a reviewer asks for an email in the `owner` key, add the address you are
   happy to have public — the file works with the GitHub username alone, but they sometimes ask.

Once merged, DNS propagates in a minute and Vercel issues the certificate automatically. Nothing
else in the project needs to change for the site to answer on the new name.

## After the registry merges it

```bash
# 1. Move every canonical, og:url, JSON-LD, sitemap and README link to the new host
node scripts/set-domain.js https://voxbridge.is-a.dev          # dry run: shows 18 files
node scripts/set-domain.js https://voxbridge.is-a.dev --apply

# 2. Commit, merge, deploy
git add -A && git commit -m "Point the site at voxbridge.is-a.dev"
```

Then, in Vercel → the project → **Settings → Domains**:

- `voxbridge.is-a.dev` is already listed; it flips to *Valid Configuration* on its own.
- Optionally set `voxbridge-mic.vercel.app` to **redirect** to the new domain so the old links
  people already shared land on the canonical one. Leave it as an alias if you would rather keep
  both answering directly.
- Re-run the smoke workflow: it now checks the new host, because `scripts/set-domain.js` rewrites
  the `base=` line in `.github/workflows/smoke.yml` too.

## Two things to fix while you are here

- **The site publishes `hello@voxbridge.app`, `privacy@voxbridge.app` and
  `security@voxbridge.app`** (31 places), but `voxbridge.app` currently resolves to a parking
  address. If you own it, set up mail forwarding; if you do not, those addresses bounce and the
  privacy policy promises a mailbox that does not exist. Either buy the domain (then Vercel can host
  the site on it and the `.is-a.dev` name becomes an alias) or change the addresses to a mailbox you
  actually read.
- **`www`**: do not add `www.voxbridge.is-a.dev`. The registry wants one file per name and a bare
  subdomain is what people will type.

## If you would rather not depend on a community registry

`voxbridge.eu.org` is the same idea run by EU.org since 1996, with no commercial use and no
JavaScript-project restriction. Approval is manual and often takes weeks — start it now in parallel
(one form, no cost) and use whichever answers first. The switch command is identical.
