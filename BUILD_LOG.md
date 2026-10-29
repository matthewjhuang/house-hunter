# Build log

## Stage 1 — Phase 1: cards, import, pipeline, notes (29 Oct 2026)

**Setup copied from Life OS** (the more recent of Life OS / Crate Cleaner, and the only one
that's a web app on Supabase): plain HTML + ES modules with no build step, one module per
feature with an `init(el)` entry, `js/supabaseClient.js` holding the URL and anon key, a
hand-written service worker with a versioned cache, and Edge Functions written in the same
style as `investment-prices`. New here, because Life OS has no precedent: a GitHub Pages
workflow, hash routing, and real migrations in `supabase/migrations/`.

**Database.** Five migrations: households and invites; properties, changes and inspection
times; comments and the checklist; push subscriptions, reminder log and Shortcut tokens;
Realtime and pg_cron. Every table is household-scoped by RLS through
`private.my_household_id()` (security definer, so `household_members` policies don't
recurse). A `before insert` trigger fills `household_id`, so the app never sends it. The
invite gate is a trigger on `auth.users` that raises for unknown emails — chosen over the
Before User Created hook because it needs no dashboard step. Security advisors: clean
(only the intentional no-policy table `reminders_sent`, and unused indexes on an empty DB).

**Listing import.** Tested against live Domain pages through a parse-only dry-run mode:
the generic walker picked up photos of *other* listings from Domain's embedded map data
and missed bond/available date (stored as `{key, value}` pairs) and the agent email
(base64), so Domain got an exact-shape extractor, with the generic walker filling gaps
and skipping `listingsMap`-style sections. REA couldn't be opened from the test browser,
so its extractor relies on the generic walker with REA's `{display, value}` wrappers and
`{size}` image templates handled. From Supabase's servers both sites refuse requests
(Domain 403, REA 429), so the blocked path is the common one: the card is created with the
link and the edit sheet opens with missing fields highlighted. The Shortcut can send
phone-fetched HTML, parsed when the server's own fetch is refused.

**iOS realities that changed the brief.** Magic links open Safari, not the installed app,
so the email also carries a 6-digit code to type in. Shortcut "open URL" also lands in
Safari, so the Shortcut posts to `share-listing` instead of deep-linking. Push needs the
app on the Home Screen, so onboarding asks for that first.

**Design.** System font sized for Dynamic Type (`font: -apple-system-body`, all sizes in
rem); iOS system colours, using the accessible variants where the default fails WCAG AA for
small text (e.g. `#0066D6` link blue at 5.4:1 instead of `#007AFF` at 4.0:1); large titles
collapsing into a blurred nav bar; bottom tab bar; sheets with grabber, swipe-to-dismiss
and one-at-a-time; long-press context menus with the card lifted above the blur; Undo
toasts instead of confirmations for reversible moves; destructive confirmation only for
Delete. No swipe actions on board cards — horizontal swipes page between stages there.

**Tested** in the browser pane at phone and wide sizes, light and dark, using `#demo`:
board paging and counts, property sheet, booking (auto-moves Saved → Inspection booked),
checklist ratings, comments, Move to…, reject with reason/note, edit and missing fields.
Backend tested against a throwaway household (since deleted): invite gate, RLS isolation
from the real household, Shortcut import of blocked links, cross-site merge by address,
and both cron jobs end to end through pg_net + Vault.

## Stage 1.1 — Password sign-in (29 Oct 2026)

Swapped the emailed-code sign-in for email + password, as in Life OS. The code flow needed
custom SMTP (Supabase's built-in email only reaches organisation members) and edited email
templates — a lot of setup for two fixed accounts. Now: "Create your password" once, then
Sign In; sessions persist. The only dashboard step is turning off "Confirm email"; the
`auth.users` invite trigger still blocks anyone else. Cache bumped to v2.

## Stage 1.2 — Domain API (29 Oct 2026)

The first real link (a Domain listing) came back blocked, as expected from servers. Rather
than fight the bot check, Domain links now go through Domain's official API
(`/v1/listings/{id}`, API key or OAuth client credentials) when its secrets are set, with
agent/agency names as best-effort extra calls. "Needs details" now only shows when address,
rent or beds are missing (the API has no bond). Blocked cards get a **Try Again** button,
and the daily re-check re-imports blocked/partial cards so they repair themselves. Cache v3.

## Stage 1.3 — Share from Safari (29 Oct 2026)

Domain's API turned out to need an ABN, so the import path became the Share Sheet
Shortcut reading the page open in Safari (Run JavaScript; needs Allow Running Scripts).
Lessons from testing on real listings: real Domain/REA pages load the `kpsdk` bot-check
script, so it can't mark a page blocked by itself; Domain sometimes answers the server with
a 200 page that has no listing, so the page the phone shares always wins over our own
fetch. REA keeps agents under `listers` (no phone) and pads addresses with double spaces.
Leased listings move to Rejected as Missed out unless you're already approved.

Shares from the REA/Domain apps only carry a link, which no automated request can read,
so the Shortcut now saves the card and opens the listing in Safari (`x-safari-https://`)
for one more Share tap; share-listing replies "Opening it in Safari" to trigger that, and
tells you to turn on Allow Running Scripts if a Safari share arrives empty. Cache v9.
