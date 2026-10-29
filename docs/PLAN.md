# House Hunter — Phase 1 plan

## Which setup I copied, and why

The two repos are very different projects:

| | Life OS (last commit 28 Oct) | Crate Cleaner (last commit 16 Oct) |
| --- | --- | --- |
| What it is | Installable PWA on Supabase | Tauri Mac app with a Python engine |
| Frontend | Plain HTML + ES modules, no framework, no build step | Plain JS in `ui/`, inside Tauri |
| Backend | Supabase (supabase-js from esm.sh), one Deno Edge Function | None (local Python) |

**I'm following Life OS.** It's the more recent repo, and it's the only one that's a web app on Supabase. House Hunter copies these parts of it:

- `index.html`, `css/styles.css`, and `js/` split into one module per feature, each with an `initX(el)` entry point. `js/app.js` is the boot and auth shell.
- `js/supabaseClient.js` with the project URL and anon key in the file, plus the `isConfigured` guard. The anon key is public by design and RLS does the protecting, so there's no `.env` and no build-time env injection, same as Life OS.
- A hand-written `service-worker.js` that caches the app shell under a versioned `CACHE_NAME` that gets bumped every release, plus `manifest.json` and `icons/`.
- Edge Functions in `supabase/functions/<name>/index.ts`, with the same `CORS_HEADERS` and `json()` helper, `npm:@supabase/supabase-js@2`, and a header comment explaining what each one does.
- `BUILD_LOG.md` (a record of each stage and why), `.claude/launch.json` (`python3 -m http.server`), and the README's step-by-step setup style.

Where Life OS has no precedent, or the brief asks for something different:

- **Deploy:** Life OS isn't deployed (it runs locally) and has no Pages workflow. I'll add `.github/workflows/deploy.yml` using `actions/upload-pages-artifact` and `actions/deploy-pages`. There's no build step: it publishes the repo root minus `supabase/`, `docs/` and `.github/`.
- **Routing:** Life OS switches views without changing the URL. I'll use **hash routing** (`#/board`, `#/p/<id>`, `#/add?url=…`). It works under the `/house-hunter/` base path without a 404.html trick, and every refresh lands correctly. All asset paths stay relative (`./`), as they are in Life OS.
- **Schema:** Life OS uses loose `supabase_*.sql` files that get pasted into the SQL editor. The brief asks for migrations, so they'll go in `supabase/migrations/<timestamp>_<name>.sql` (Supabase CLI layout), applied through the Supabase MCP and committed.
- **Look and auth:** Life OS uses custom fonts and password sign-in. House Hunter uses the SF system font with iOS system colours, and sign-in by emailed link or code (see below).

## Things the brief can't do as written on iOS, and what I'll do instead

1. **Magic links don't open the installed PWA.** Tapping the email link opens Safari, and Safari's session isn't shared with the Home Screen app, so you'd be signed in to Safari and still signed out of the app. **Fix:** the same email carries a link *and* a 6-digit code (`{{ .Token }}` in the email template). In the installed app you type the code; in a browser the link works as usual.
2. **A Shortcut that opens a URL opens Safari, not the PWA.** So `/add?url=…` on its own doesn't land in the installed app on iPhone. **Fix:** the main iOS path is the "optional" endpoint. The Shortcut POSTs the listing URL to a `share-listing` Edge Function using a personal token from Settings. The card gets created in the background, the Shortcut shows "Added 12 Smith St, Brunswick", and Realtime puts it on both boards. `#/add?url=` still works on Android, desktop and in Safari.
3. **Push only works after "Add to Home Screen"** (iOS 16.4+), and the permission has to be requested from a tap. Onboarding detects whether it's running in Safari or standalone and walks through both steps.

## Schema (one migration per area)

All tables have RLS on and a `household_id`. Policies use a `security definer` helper, `private.my_household_ids()`, so they don't recurse through `household_members`. A `before insert` trigger fills `household_id` from the signed-in user, so the client never sends it.

| Table | Key columns | Notes |
| --- | --- | --- |
| `households` | `name`, `max_rent_pw`, `created_at` | Holds household settings. I folded the suggested `settings` table in here |
| `household_members` | `household_id`, `user_id`, `display_name`, `reminder_lead_minutes` (default 60) | Reminder timing is per person, because push goes to each person |
| `household_invites` | `email` (pk), `household_id`, `display_name` | The allowlist |
| `share_tokens` | `user_id`, `token_hash`, `created_at` | For the iOS Shortcut. Only a hash is stored |
| `properties` | `stage` (enum), `position` (float, order within a column), `rejected_reason` (enum), `rejected_note`, `rejected_from_stage`; `address`, `suburb`, `postcode`, `address_key` (normalised, **unique per household**: this is how duplicates merge); `rent_pw`, `bond`, `beds`, `baths`, `cars`, `available_date`; `agent_name`, `agency`, `agent_phone`, `agent_email`; `photo_urls text[]`; `sources jsonb` (`[{site, url, listing_id}]`); `listing_status` (active / under_application / leased / removed); `parse_status` (ok / partial / blocked), `missing_fields text[]`; `last_checked_at`, `has_unseen_changes`, `created_by` | `sources` replaces `source_urls[]` so each link keeps its own listing ID |
| `property_changes` | `property_id`, `kind` (price / status / removed), `old_value`, `new_value`, `detected_at`, `seen_at` | Change history and the badge |
| `inspection_times` | `property_id`, `starts_at`, `ends_at`, `booked` (bool), `origin` (parsed / manual) | Only booked inspections send reminders |
| `reminders_sent` | `inspection_id`, `user_id` | Stops a reminder being sent twice |
| `comments` | `property_id`, `author_id`, `body`, `created_at`, `edited_at` | Only the author can update or delete |
| `checklist_items` | `property_id`, `label`, `position`, `rating` (good / okay / bad / null), `note`, `is_custom` | The 11 default items are seeded by a trigger when a property is created |
| `push_subscriptions` | `user_id`, `endpoint` (unique), `p256dh`, `auth` | |

`places` and `travel_times` arrive in a Phase 2 migration. Realtime is enabled on `properties`, `comments`, `checklist_items`, `inspection_times` and `property_changes`. RLS applies to Realtime too.

**Invites:** an `after insert` trigger on `auth.users` raises an error for any email that's not in `household_invites`, which makes Auth refuse the sign-up. For an invited email, it adds the user to that household. *(Changed while building: this replaced the Before User Created hook, so there's no dashboard step.)* After the migrations I'll run the security and performance advisors and fix what they find.

## Edge Functions

| Function | Called by | What it does |
| --- | --- | --- |
| `parse-listing` | the app (user JWT) | Validates the URL: https only, no private IPs, known hosts get site-specific extractors and others fall back to the generic path. Fetches with browser-like headers and a 10 s timeout. Parses JSON-LD, then `__NEXT_DATA__` or other embedded JSON (REA's Argonaut payload, Domain's Next data), then OG and meta tags. Normalises the address, then **upserts**: if `address_key` already exists, it adds the new source to the existing card. Returns `{property_id, parse_status, missing_fields}`. When blocked, it still creates the card with the URL and `parse_status = blocked` |
| `share-listing` | the iOS Shortcut | Takes `{url}` plus a `Bearer <share token>`. Looks up the token's user, then runs the same parse and upsert (shared `_shared/listing.ts`). Returns a one-line summary for the Shortcut's notification |
| `recheck-listings` | pg_cron, daily ~6am Melbourne | Re-fetches the sources of every property not in Rejected or Lease signed, one after another with a short delay. Records price and status changes; a 404 or 410 counts as removed. Sets `has_unseen_changes` |
| `send-reminders` | pg_cron, every 5 min | Finds booked inspections where `starts_at − lead ≤ now` with no `reminders_sent` row. Sends Web Push with VAPID (web-push library, checked at build time). Deletes subscriptions that come back 410 |

The cron jobs call the functions through `pg_net`, with a secret stored in Supabase Vault and checked in the function.

## Screens

Everything uses the SF system font. Text sizes come from `font: -apple-system-body` and the related styles, so they follow the phone's Dynamic Type setting. Colours are iOS system colours set as CSS tokens, with light and dark values switched by `prefers-color-scheme`. The tab bar respects safe areas through `env(safe-area-inset-*)`.

- **Sign in:** email → "Check your email" → 6-digit code field.
- **Onboarding** (first run): in Safari, an Add to Home Screen walkthrough. Once installed, a "Turn on inspection reminders" button.
- **Board** tab: a large title that collapses into the nav bar. A scrollable stage selector with counts (Saved 4 · Inspection booked 2 · …, with Rejected set apart at the end) sits over horizontally paged stage columns (scroll-snap). On screens ≥ 768 px wide the columns sit side by side and cards can be dragged between them.
  - A **+** in the nav bar opens the **Add sheet**: paste a link (Paste button), or "Enter details manually".
  - **Card:** photo (placeholder if it fails to load), $/wk in large text, beds · baths · cars, suburb, next inspection, comment count. "Over budget by $40" appears as text plus a red tint, so it's never colour alone. It also shows a change badge and a "Needs details" badge.
  - **Long-press context menu:** Move to… (submenu), Mark inspection booked, Open listing, Reject, and Delete last, styled as destructive. I'm leaving swipe actions off the board cards because a horizontal swipe would clash with paging between stages. Swipe-to-delete goes on your own comments instead.
- **Property sheet** (grabber, swipe down to dismiss): photo carousel; a header with rent, address, and Move to… / Reject; the change history; inspections (tap to mark booked or add one); agent, with tap-to-call and tap-to-email; source links; the checklist (Good / Okay / Bad segmented control per row plus a note, and "Add item"); the comment thread with a composer; and **Edit**, which swaps to the edit sheet so only one sheet is open at a time.
- **Edit sheet:** every field, with missing ones highlighted. Cancel and Save.
- **Reject sheet:** reason chips plus an optional note. Restoring returns the card to `rejected_from_stage`.
- **Map and Places** tabs: a "Coming in Phase 2" state with a short description of what each tab will do.
- **Settings:** max rent per week, reminder lead time, notification status and toggle, iOS Shortcut (generate or revoke token, setup steps), members, sign out, version.
- **States:** skeleton cards while loading, an empty state per stage ("Nothing inspected yet"), an offline banner, and inline parse errors that say what's missing and offer to fill it in by hand.

## Deploy and commit order

1. `git init`; scaffold (index, styles, client, manifest, icons, SW, launch.json, README stub)
2. Create Supabase project **HouseHunter** (ap-southeast-2, $0/month free tier, your second free project)
3. Migrations: core and households → properties → notes → push → cron. Apply each one, then run the advisors
4. Auth shell + onboarding
5. Board + realtime
6. Add flow + `parse-listing` (tested against real REA and Domain URLs) → `share-listing`
7. Property sheet, checklist, comments, reject
8. Settings + push + `send-reminders` → `recheck-listings`
9. Pages workflow, README (setup, secrets, Shortcut steps), push to GitHub, smoke test on the live URL

## What I need from you

**Before I start:**
- Both email addresses and display names (for the invite list).
- OK to create the free Supabase project and a **public** `matthewjhuang/house-hunter` GitHub repo. GitHub Pages on a free plan needs a public repo, and nothing secret will be in it.
- OK with the 6-digit code alongside the magic link.

**By hand later** (the README will have exact steps):
- Supabase Auth: set the Site URL and redirect URL to the Pages URL, add `{{ .Token }}` to the magic-link email template.
- Supabase secrets: the VAPID public and private keys and subject. I'll generate the keys for you.
- GitHub repo → Settings → Pages → Source: **GitHub Actions**.
- On each iPhone: install the PWA, allow notifications, and add the Shortcut.

**Heads-up:** free Supabase projects pause after a week with no activity. The daily cron job may not count as activity, so this needs watching.
