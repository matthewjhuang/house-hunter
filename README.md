# House Hunter

Our shared board for Melbourne rentals. Paste (or share) a realestate.com.au or Domain
listing, and it becomes a card that moves through
**Saved → Inspection booked → Inspected → Applied → Approved → Lease signed** (or
**Rejected**, with a reason, restorable any time). Each card has a comment thread, an
inspection checklist, the agent's details and a reminder before each booked inspection.
Whatever one of us does shows up live on the other's phone.

It's an installable web app (PWA) designed to feel like a native iPhone app, and it's built
the same way as Life OS: plain HTML, CSS and ES modules, no framework and no build step.

- **Live app:** https://matthewjhuang.github.io/house-hunter/
- **Backend:** Supabase project `HouseHunter` (`esifddbuuyztqcqqebgx`, Sydney)

Application documents (ID, payslips, references) are never stored here — only listing
details, notes and links. Photos are kept as links to the listing site's own images.

---

## Project layout

```
index.html            App shell, sign-in, tab bar, SVG icon set
css/styles.css        iOS-style tokens (light/dark), components
js/app.js             Boot, sign-in, hash routing, tabs
js/store.js           In-memory data + Supabase Realtime; all writes go through here
js/board.js           Board tab (stage picker + paged columns / side-by-side columns)
js/propertySheet.js   Property detail sheet: photos, inspections, checklist, comments
js/editSheet.js       Edit / add-by-hand sheet
js/addSheet.js        Paste-a-link sheet → parse-listing
js/actions.js         Move / reject / restore / delete, shared by the board and sheet
js/settings.js        Settings tab, Shortcut token
js/places.js          Places tab and the add / edit place sheet
js/travel.js          "Getting around" on the property sheet, travel line on cards
js/map.js             Map tab (MapLibre + OpenFreeMap, loaded on first open)
js/push.js            Web Push subscribe / unsubscribe / test
js/onboarding.js      Add to Home Screen + reminders prompts
js/ui.js              Sheets, context menus, alerts, toasts, long-press, swipe rows
js/format.js          Stages, reasons, money/date formatting, address normalising
js/demo.js            Sample data for local design testing (not deployed)
service-worker.js     App-shell cache + push notifications (bump CACHE_NAME each release)
manifest.json         PWA manifest, incl. share_target for Android
supabase/migrations/  Database schema, applied in order
supabase/functions/   Edge Functions (Deno)
docs/PLAN.md          The Phase 1 plan
BUILD_LOG.md          What was built and why, stage by stage
```

Routes are hash-based so GitHub Pages never sees them and refreshes always work:
`#/board`, `#/p/<id>`, `#/add?url=…`, `#/map`, `#/map/p/<id>` (a listing opened over the
map), `#/places`, `#/settings`. Plain
`?url=…` links (and Android's share target) are turned into `#/add` on load.

## Run it locally

```bash
python3 -m http.server 5501
```

- `http://localhost:5501/#demo` — the whole UI with sample data, no sign-in. Nothing is saved.
- `http://localhost:5501/` — the real app against Supabase (same sign-in as the live site).

The service worker caches the app shell, so after editing files reload twice (or tick
"Update on reload" in DevTools → Application → Service Workers).

---

## Setup (already done, except where marked ✋)

### 1. Supabase database

The schema lives in `supabase/migrations/` and has been applied to the `HouseHunter`
project. To rebuild from scratch, run the files in order in the SQL Editor (or
`supabase db push` with the Supabase CLI).

- Every table has Row Level Security. Rows belong to a `household_id`, and policies only
  allow the signed-in person's own household (`private.my_household_id()`).
- **Invites:** a trigger on `auth.users` only lets emails in `household_invites` create an
  account, and adds them to that household. The household and both invites are created by
  the first migration. To change an email:
  `update household_invites set email = 'new@example.com' where email = 'old@example.com';`
- New cards get the 11-item inspection checklist automatically.
- `pg_cron` runs `travel-times` nightly at 16:30 UTC (3:30am Melbourne in summer), `send-reminders` every 5 minutes and `recheck-listings` daily at 19:00 UTC
  (5–6am Melbourne). They authenticate with a random secret stored in Supabase Vault.

### 2. ✋ Auth setting (one switch)

Sign-in is email + password, like Life OS. Only the two invited emails can create an
account; each of you creates your password once, on first sign-in, and the app keeps you
signed in after that.

Supabase dashboard → **Authentication → Sign In / Providers → Email** → turn **off**
"Confirm email" → Save. (No emails are sent, so no SMTP or templates are needed. It's
safe because the invite trigger refuses every other email.)

Forgot a password? Ask Claude (or run SQL in the dashboard) to set a new one:
`update auth.users set encrypted_password = extensions.crypt('new-password', extensions.gen_salt('bf')) where email = '…';`

### 3. ✋ Push notifications (VAPID keys)

The key pair was generated locally into `supabase/vapid.local` (git-ignored). In Supabase →
Edge Functions → **Secrets**, add:

| Name | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | from `supabase/vapid.local` |
| `VAPID_PRIVATE_KEY` | from `supabase/vapid.local` |
| `VAPID_SUBJECT` | `mailto:matthewjhuang@gmail.com` |

The public key is also in `js/supabaseClient.js` (`VAPID_PUBLIC_KEY`) — if you ever
regenerate the pair (`npx web-push generate-vapid-keys`), update both, and everyone has to
turn notifications off and on again in Settings. Until the secrets are set,
`send-reminders` replies "VAPID keys aren't set yet" and sends nothing.

### 3b. ✋ Domain API (so Domain links fill in automatically)

Domain blocks page requests from servers, so Domain links are read from Domain's official
API instead. It's free (developer.domain.com.au).

1. Sign up at https://developer.domain.com.au and **Create Project** (any name, e.g. House Hunter).
2. In the project, **API Access → Add API** → choose **Agents & Listings**, free plan.
3. **Credentials → Create** → choose **OAuth client** (recommended) or **API Key**.
4. In Supabase → Edge Functions → **Secrets**, add either
   - `DOMAIN_CLIENT_ID` and `DOMAIN_CLIENT_SECRET` (OAuth client), or
   - `DOMAIN_API_KEY` (API key).
5. Open any blocked Domain card and tap **Try Again**. Cards also repair themselves on the
   next daily re-check.

The API has everything except bond. REA has no public API, so REA links still rely on the
page (or the Shortcut fetching it on your phone).

### 4. Edge Functions

All five are deployed. To redeploy after changes (Supabase CLI):

```bash
supabase functions deploy parse-listing --project-ref esifddbuuyztqcqqebgx
```

```bash
supabase functions deploy share-listing recheck-listings send-reminders travel-times --no-verify-jwt --project-ref esifddbuuyztqcqqebgx
```

| Function | Called by | Auth |
| --- | --- | --- |
| `parse-listing` | the app's Add sheet | signed-in session (JWT verified) |
| `share-listing` | the iOS Shortcut | personal token from Settings (hash stored) |
| `recheck-listings` | pg_cron, daily | `x-cron-secret` from Vault |
| `send-reminders` | pg_cron every 5 min; Settings → "Send a Test Notification" | `x-cron-secret`, or session for the test |
| `travel-times` | database triggers (new or changed property or place), pg_cron nightly, the sheet's Recalculate | `x-cron-secret`, or session for Recalculate |

**How listing import works.** The function fetches the page and reads, in order: JSON-LD;
embedded app data (Domain's `__NEXT_DATA__` by its exact shape, REA's `ArgonautExchange`
generically); then Open Graph / meta tags and page text. Duplicate properties (the same
rental on REA and Domain) are merged on a normalised address (`3/12 smith st brunswick`),
keeping both links.

**Expect blocking.** With the Domain API set up (3b), Domain links don't touch the website
at all. Otherwise both sites usually refuse requests from servers (in testing: Domain 403,
REA 429). That's handled: the card is still created with the link, marked "Needs details",
and the edit sheet opens with the missing fields highlighted. The iOS Shortcut can also
fetch the page on your phone (step 4 below), which the sites block far less often; the
server parses that HTML when its own request is refused.

There's a parse-only test mode, handy if a site changes its layout: save a listing page
and send `{ "dry_run": true, "html": "<page html>" }` to `parse-listing` with the anon key.

### 5. ✋ GitHub Pages

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**. After that,
every push to `main` deploys via `.github/workflows/deploy.yml`.

---

## On your iPhones

1. Open https://matthewjhuang.github.io/house-hunter/ in **Safari**.
2. Share → **Add to Home Screen** → Add. Open House Hunter from the Home Screen.
3. Tap **First time? Create your password**, enter your invited email and a password
   (8+ characters), then **Create Account**. After that it's just **Sign In**.
4. Tap **Turn On Reminders** when asked (or Settings → Notifications). iPhone only allows
   notifications for Home Screen apps, iOS 16.4 or later.
5. Settings → Budget: set your max rent per week. Cards above it show "Over budget".

## Adding listings

REA and Domain block automated requests (from our server and from Shortcuts alike), and
neither offers a usable public API (Domain's is business-only), so:

- **Share from Safari (everything filled in).** Open the listing in Safari → Share →
  **Add to House Hunter**. The Shortcut reads the page you're looking at, which the sites
  can't block, and the card appears on both boards with rent, photos, agent and inspections.
- **Share from the REA/Domain apps (two taps).** The apps only share a link, so the card
  starts with what the link says (the full address for Domain, type and suburb for REA),
  then the Shortcut opens the listing in Safari (`x-safari-https://`, so it doesn't bounce
  back to the app). Tap Share → **Add to House Hunter** there and the same card fills in.
- **Paste a link in the app (address only).** Same starting card; share the listing from
  Safari later to fill it in.

### One-time setup on each iPhone

1. House Hunter → **Settings → Share from REA & Domain → Create Your Shortcut Token**; copy it.
2. Open https://matthewjhuang.github.io/house-hunter/add-to-house-hunter.shortcut →
   **Download** → open it from Safari's Downloads → **Add Shortcut** → paste the token.
   (Or, on a Mac with the same Apple ID, double-click the file — iCloud syncs it.)
3. iPhone **Settings → Apps → Shortcuts → Advanced → Allow Running Scripts** → on.

The Shortcut is generated by `shortcut/build.py` and signed on a Mac:

```bash
python3 shortcut/build.py && shortcuts sign --mode anyone --input shortcut/add-to-house-hunter.unsigned.shortcut --output add-to-house-hunter.shortcut
```

Its steps, if you'd rather build it by hand: Get URLs from Input → Get Item from List (first)
→ Get Contents of URL (GET, reads the page on the phone) → Get Contents of URL (POST to
`https://esifddbuuyztqcqqebgx.supabase.co/functions/v1/share-listing`, header
`Authorization: Bearer <token>`, JSON body `url` = the link, `html` = the page) → Show
Notification with the reply.

Lost the token, or a phone? Settings → **Make a New Token** (the old one stops working) or
**Revoke Token**.

Other deep links: `https://matthewjhuang.github.io/house-hunter/#/add?url=<listing url>`
opens the Add sheet and imports straight away (in a browser, or on Android). Android's
Share menu lists House Hunter once it's installed (`share_target` in the manifest).

---

## Places, travel times and the map

- **Places tab.** Each of you adds the places you go every week (work, study, the gym,
  family), each one yours, Hannah's or both of yours, and set how you usually get there:
  car or public transport. New places start with their owner's way (Matthew drives, Hannah
  takes public transport, shared places use public transport). Turn on **Show on Cards** for
  the one or two that matter most.
- **Getting around** on every listing that isn't Rejected: the nearest train station and tram
  stop with the walk to each, then public transport and car times to every place, for a
  weekday trip arriving 8:30am. Tap a place to get directions in Google Maps or type in your
  own time (yours always wins and is never overwritten). Each place's usual way is listed
  first. Cards show the time to the Show on Cards places the usual way (e.g. "Matthew
  ~18 min" by car, "Hannah 57 min" by train) and the walk to the nearest stop.
  To change someone's default for new places:
  `update household_members set travel_mode = 'transit' where display_name = 'Matthew';`
  (and the same on `household_invites` for anyone who hasn't signed up yet).
- **Map tab.** Every listing that isn't Rejected as a price pin in its stage colour, and
  your places as square markers. Filter by stage, tap a pin for a preview, tap the preview to
  open the listing.

**No keys, no billing.** Everything is free, open data:

| What | Service | Notes |
| --- | --- | --- |
| Addresses → coordinates | [Photon](https://photon.komoot.io) (OpenStreetMap) | Nominatim refuses requests from Supabase's servers |
| Public transport | [Transitous](https://transitous.org) (PTV timetables) | Arrive-by routing; also supplies the nearby stop list |
| Car and walking | [OSRM](https://routing.openstreetmap.de) (FOSSGIS) | No traffic data, so car times are × 1.6 as a rush-hour allowance and shown with "~" |
| Map | [OpenFreeMap](https://openfreemap.org) tiles, drawn by MapLibre | Light and dark styles follow the phone |

They're community-run, so they can be slow or down for a while. Failed times are stored as
errors and retried by the nightly run, or straight away with **Recalculate** at the bottom of
Getting around.

**How it runs.** `travel_times` caches one row per listing, place and mode. Database
triggers call `travel-times` when a listing or place is added, its address changes, or a
listing comes back from Rejected (so the import functions don't need to know). A new address
clears the old coordinates unless the same update brings new ones (as imports do). Listings
that only match a suburb get no times: the sheet asks you to check the address. The
nightly run fills gaps and refreshes anything older than four weeks.

## Things to know

- **Free-tier pausing:** free Supabase projects pause after a week with no activity. If
  the app ever shows "Couldn't load your board", check the Supabase dashboard and restore
  the project.
- **Daily re-check** only flags changes it can see. While a site is blocking server
  requests, its listings aren't re-checked (they're never wrongly marked removed).
- After changing any file the app loads, bump `CACHE_NAME` in `service-worker.js` so phones
  pick up the new version.
