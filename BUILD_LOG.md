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

## Stage 2 — Places, travel times and the map (30 Oct 2026)

**Free services instead of Google.** The plan was Google Maps Platform, but Google needs a
card on file even for free usage, so it's all open data with no keys: Photon for geocoding,
Transitous (MOTIS over PTV's GTFS) for arrive-by public transport and the nearby stop list,
FOSSGIS OSRM for car and walking, and OpenFreeMap vector tiles drawn by MapLibre. Checked
before building: Brunswick → Collins St came back as 40 min on the Upfield line (with Metro
Tunnel stations in the alternatives). Found while testing from Supabase: Nominatim answers
Supabase's servers with 403 (hence Photon), Overpass was flaky (502/406, hence Transitous'
stop list, which is PTV's own data anyway), and CARTO's raster basemaps now need an API key
(hence OpenFreeMap, which has a dark style). OSRM has no traffic, so car times are × 1.6 and
labelled "~".

**Database.** One migration: `places` (owner or both, kind, Show on Cards, coordinates and
geocode status), `travel_times` (one row per listing × place × mode, with a fingerprint of
the coordinates so unchanged pairs aren't recomputed), and `geocode_status` /
`nearest_stops` on properties. People can read times and update only `manual_s` (column
grant); everything else is written by the function. Triggers clear stale coordinates when an
address changes and call `travel-times` through pg_net, so the import code is untouched.
Tested end to end against a throwaway household (since deleted): geocode → stops → both
modes, from the trigger path.

**Design.** Places is a grouped list per person with kind tiles, an "On cards" tag, and inline
"Finding it on the map…" / "Address not found" states that update live. The add sheet uses
chips for kind, a segmented control for whose, and an iOS switch for Show on Cards (on by
default for work and study). On the sheet, Getting around sits after Inspections; your own
time is entered inline (no second sheet, since sheets never stack) and tagged "Yours". The
map is full-bleed with floating chips, a fit button below them, and a preview card above the
tab bar; listings open over the map at `#/map/p/<id>` and closing returns there. Price pins
use the stage colours with dark text in dark mode, where those colours are bright.

**Tested** in the browser pane with `#demo` (sample places, times and stops), phone size,
light and dark: Places list/add/edit states, Getting around, typing your own time (and that
the card follows), map pins, filters, preview, opening and closing a listing from the map.
Cache v10.

## Stage 2.1 — Usual way to travel (30 Oct 2026)

Matthew drives and Hannah takes public transport, so each person has a `travel_mode`
(on `household_members`, and on `household_invites` so Hannah's carries over when she signs
up), and each place has its own, starting from its owner's. Cards show each place's time the
usual way, with a car or train glyph; the sheet lists the usual way first and dims the other.
Both modes are still computed. Existing places owned by Matthew were switched to car.

## Stage 2.2 — Places for someone who hasn't signed up yet (30 Oct 2026)

Hannah hadn't created her account, so she wasn't in "Whose" and Matthew couldn't add her
places. Places can now belong to an invite (`places.owner_invite`, the invite email, with a
check that only one of `owner_id` / `owner_invite` is set). The sign-up trigger moves those
places to the new account. In the app, owners are keyed as a user id, `invite:<email>` or
"" (both); invitees use their invite's travel mode. Handover tested in a rolled-back
transaction (insert into `auth.users` → place moved to the new user).

