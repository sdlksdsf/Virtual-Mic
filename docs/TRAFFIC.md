# Getting VoxBridge in front of people

A zero-budget, honest traffic plan for a free, MIT-licensed utility. No paid ads in phase 1, no
fake reviews, no vote brigading. Everything here is a task someone can start today.

**Positioning, one line:** *Turn the phone in your pocket into a studio microphone for Windows —
local-only, ~60 ms, no account.*

**Who wants this** (in order of intent): people whose laptop mic sounds bad on Zoom/Teams calls;
streamers and podcasters who want a second mic for free; people with a spare phone; privacy-minded
users who refuse cloud-relay mic apps; teachers and creators recording screencasts.

---

## 1. The one thing that compounds: search

Every other channel below is a spike. Search is the only channel that keeps delivering after you
stop working, and VoxBridge already has the hard part — a real product that solves the query.

**Already published:** `/phone-as-microphone` (HowTo + FAQ structured data), plus the canonical
pages for download, setup, features, security, privacy.

**Next pages to write, in this order.** One page each, 800–1,200 words, genuinely useful, with the
same JSON-LD pattern as the guide. Do not publish them all at once — one per week, and only if you
can make each one the best answer to its query.

| Query to own | Suggested URL | Angle no one else has |
|---|---|---|
| `phone as microphone for zoom` | `/phone-as-mic-zoom` | The exact Zoom device setting + the "join a test meeting" check |
| `iphone as microphone for windows` | `/iphone-as-mic-windows` | Honest note: unsigned IPA, AltStore/Sideloadly, what iOS allows |
| `use android phone as mic for pc` | `/android-as-mic-pc` | APK sideload + USB `adb reverse` fallback |
| `wireless microphone for pc free` | `/wireless-mic-pc` | Latency table vs $30–200 USB mics, no affiliate links |
| `vb-cable alternative` | `/virtual-audio-cable` | Why we use VB-CABLE instead of shipping a kernel driver |
| `phone as mic for obs` | `/phone-as-mic-obs` | OBS device picker + monitor-off warning (echo) |

Rules that keep these pages from being thin content: one `h1`, a real measurement or screenshot in
each, internal links back to `/download`, and a canonical URL. The site's own `scripts/lint.js` and
the SEO harness catch most mistakes.

**Search Console** is not optional — it is how you learn which queries you already rank 8th for.
Add the domain, submit `https://voxbridge-app-pi.vercel.app/sitemap.xml`, and check
*Performance → Queries* weekly. A page stuck at position 6–12 is usually one paragraph away from
page one.

**A custom domain helps.** `voxbridge.app` in the search result reads better than
`voxbridge-app-pi.vercel.app`, and some directories reject `.vercel.app` links. Adding it in Vercel
takes minutes and costs the price of the domain; `hello@voxbridge.app` is already the contact
address used on the site, so the domain is expected.

---

## 2. GitHub is a search engine too

1. **Repo metadata** (needs the repo owner — the API token used by automation cannot write it):
   - Description: `Turn your phone into a studio microphone for Windows — local-only, ~60 ms, free and MIT licensed.`
   - Website: `https://voxbridge-app-pi.vercel.app`
   - Topics: `microphone` `virtual-audio` `phone-as-mic` `audio` `windows` `android` `ios` `webrtc`
     `low-latency` `obs` `podcast` `self-hosted` `privacy` `electron` (pick ~12; topics are how
     GitHub's topic pages and third-party "trending" sites find you).
   - Enable **Discussions** (one more indexed surface, and a place for "does it work with…?" posts).
2. **README first screen**: already has the download line and screenshots. Add a "Works with" line
   naming Zoom, Teams, Discord, OBS, Google Meet — that is literally what people search.
3. **Awesome lists** — small PRs, permanent backlinks. Read each list's contribution rules first.
   Candidates: `awesome-selfhosted` (only if it fits their server-software definition — check),
   `awesome-privacy`, `awesome-audio`, `awesome-windows-apps`, `awesome-android`,
   `awesome-open-source-software`, `awesome-indie`. One sentence, no marketing voice.
4. **Release pages are landing pages.** Anyone searching "voxbridge" lands there; keep the notes
   consumer-readable (they are now) and keep the download table at the top.

---

## 3. Launch posts (do them once, do them well)

Each of these is a one-shot spike. Prepare the post, the screenshots and a first comment *before*
posting, and be present for the next four hours to answer questions — engagement in the first hour
decides the outcome.

### Hacker News — "Show HN"
- Title: `Show HN: VoxBridge – use your phone as a low-latency mic for Windows`
- Body (short, no marketing): what it does, why (cloud mic apps add latency and an account), how it
  works (UDP PCM over LAN into VB-CABLE, ~60 ms), what is rough (unsigned Windows build, unsigned
  IPA), link to the repo and the site.
- Post 6–9 am Pacific, Tuesday–Thursday. Do not ask for upvotes anywhere.
- Expect technical scrutiny of the protocol and the virtual cable choice — `docs/PROTOCOL.md` exists
  for exactly this.

### Reddit
Post as a person, disclose that you built it, and **read each subreddit's self-promotion rule first**
— several require a minimum account age or a weekly promo thread.

| Subreddit | What to post | Notes |
|---|---|---|
| r/selfhosted | "Local-only phone→PC mic, no cloud relay" | Fit the local-first ethos; check promo rules |
| r/software | Short description + screenshots | Very strict on spam |
| r/opensource | MIT, built in public with Actions | Link the repo, not the site |
| r/AndroidApps | APK + what it pairs with | Needs a dev flair/verification on some days |
| r/podcasting | "Free second mic from a spare phone" | Value-first, no link drop |
| r/Twitch, r/obs | "Phone as a second mic / wireless mic" | Show the OBS device picker |
| r/Windows10, r/Windows11 | Utility post | Check the weekly promo thread |
| r/SideProject, r/coolgithubprojects | Build story | Low intent, but cheap |

### Product Hunt
Needs a real account, 3–5 gallery images (the site's 2400 px WebP screenshots work), a 60-character
tagline, and the maker's first comment explaining the build. Launch 12:01 am Pacific; ask your own
network for *feedback*, not upvotes. Product Hunt traffic converts poorly for Windows utilities but
the backlink and the evergreen listing are worth the day.

### X / Mastodon / LinkedIn / Bluesky
One thread, one 20-second screen recording: bad laptop mic → install → phone pairs → same sentence
sounds better. The recording matters more than the copy. LinkedIn works surprisingly well for the
"better calls" framing; tag no one.

---

## 4. Directories and package managers (evergreen, low effort each)

These are where people look when they have already decided to install something.

**Package managers** (biggest long-tail win — `winget install` is now the default way Windows users
find CLI/utility apps):

- **winget**: run `wingetcreate new https://github.com/sdlksdsf/Virtual-Mic/releases/download/v1.0.1/VoxBridge-Setup-1.0.1-x64.exe`
  on a Windows box, then submit the generated PR to `microsoft/winget-pkgs`. First submission is
  reviewed by a human (a few days).
- **Scoop**: a bucket manifest can be installed straight from a raw URL before any bucket accepts
  it — the portable zip plus a shortcut is enough.
- **Chocolatey**: `choco pack` + community moderation; needs the checksums (they are in the release
  notes) and a maintainer account.

**Directories** (free listings, most accept a submission form):

- AlternativeTo — highest intent ("alternative to …" searches); list as an alternative to
  WO Mic, DroidCam, Camo, VB-CABLE setups.
- Slant, LibHunt, Open Source Agenda, FossHub, MajorGeeks, Softpedia, SourceForge (mirror + badge).
- APK mirrors: APKMirror (needs a consistent signing key and an account), APKPure. Note that
  Obtainium users can add the GitHub release URL directly — mention that in the README for the
  power users who search "obtainium".
- Privacy-focused lists: PrivacyTools-style directories and `awesome-privacy` PRs.

Submit one or two per day rather than 20 in one afternoon; most forms are manually reviewed and a
burst looks automated.

---

## 5. Video, the highest-converting format for this product

A phone-as-mic demo is inherently visual and audible — that is an advantage over most utilities.

- **One 30-second vertical clip**: "Your laptop mic vs the phone in your pocket" — same sentence,
  two recordings, waveform on screen, no talking head needed. Post to YouTube Shorts, TikTok,
  Instagram Reels, and as an X/Bluesky native video.
- **One 3–5 minute YouTube video**: full setup on Windows + Zoom, including the parts that go wrong
  (SmartScreen, firewall, `CABLE Output`). Chapters = search snippets.
- **Answer-first comments** on existing "phone as microphone" videos and forum threads: explain the
  actual problem (Windows needs a recording endpoint), mention the tool only if it is relevant.
  This is the highest-ROI hour you can spend on YouTube and it costs nothing.

---

## 6. Measurement — so you know which channel to repeat

Every page now writes one row to the Supabase `page_events` table: path, referring domain and any
`utm_*` tag. A duplicated beacon from the same page load is discarded, so a number is a page load,
not an impression twice-counted. No cookie, no identifier, no IP — the same stance as the download counter, and disclosed
in `/privacy`. Click events were already recorded in `download_events`. Between the two you can
answer the two questions that matter per channel: how many people arrived, and did they download.

Use consistent UTM tags on every link you post:

```
https://voxbridge-app-pi.vercel.app/?utm_source=reddit&utm_medium=social&utm_campaign=launch_w1
https://voxbridge-app-pi.vercel.app/phone-as-microphone?utm_source=hn&utm_medium=social&utm_campaign=show_hn
```

Convention: `utm_source` = reddit | hn | ph | x | yt | altto | winget; `utm_medium` = social |
directory | video | package; `utm_campaign` = launch_w1, evergreen, etc.

**Weekly numbers to look at** (five minutes, every Monday):

1. Sessions and top referrers — which channel actually sent people.
2. `/download` → download-click rate. If people land and do not download, the page is the problem.
3. Search Console: impressions, clicks, average position. Rising impressions with flat clicks means
   titles/descriptions need work, not more pages.
4. Supabase download rows by platform — Android vs Windows tells you which audience you actually
   reached.

Two queries worth saving in the Supabase SQL editor:

```sql
-- which channel sent people, last 14 days
select coalesce(nullif(referrer, ''), 'direct') as source, count(*) as views
from public.page_events
where created_at > now() - interval '14 days'
group by 1 order by 2 desc;

-- landing pages, last 14 days
select path, count(*) as views
from public.page_events
where created_at > now() - interval '14 days'
group by 1 order by 2 desc;
```

Join them against `download_events` for the number that actually matters — visits per download.
Rows are tiny, but delete anything older than a year when you remember:

```sql
delete from public.page_events where created_at < now() - interval '365 days';
```

Do not chase daily numbers; the site is small enough that one Reddit post looks like a triumph and
the next day looks like failure.

---

## 7. First four weeks

| Week | Do |
|---|---|
| 1 | Fix repo metadata/topics (owner), add Search Console + sitemap, publish the clip, one directory submission per day, prep the HN/PH copy |
| 2 | Show HN on a Tue–Wed morning; answer everything; post to two subreddits the same week (different days) |
| 3 | Product Hunt; publish page #2 (`/phone-as-mic-zoom`); winget PR |
| 4 | Publish page #3; scoop manifest; pitch two small YouTube channels with a ready-made demo clip; review analytics and double down on the one channel that worked |

**Do not:** buy reviews or stars, post the same link to five subreddits in an hour, DM strangers,
stuff keywords into the README, or add an install-count badge that looks like a rating.

**The honest expectation:** a launch spike of a few hundred visits, then a slow floor of search
traffic. Utilities win by being the answer to a specific query for years, not by one good day on
Hacker News. The pages and the package-manager listings are the assets that keep working.
