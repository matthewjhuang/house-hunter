-- Phase 2: each person's essential places, travel times from every active property
-- to every place, and the nearest train station / tram stop for each property.
--
-- Everything is computed by the travel-times Edge Function using free OpenStreetMap
-- services (Nominatim, OSRM, Overpass) and Transitous for public transport. Triggers
-- here call it whenever a property or place is added or its address changes, so the
-- listing import code doesn't need to know about any of this. A nightly job fills
-- gaps and refreshes old times.

create type public.place_kind as enum ('work', 'study', 'gym', 'shops', 'family', 'other');

create table public.places (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  -- Whose place it is; null means both of you.
  owner_id uuid references auth.users (id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 80),
  kind public.place_kind not null default 'other',
  address text not null check (length(trim(address)) between 3 and 200),
  -- Shows the public transport time to this place on every board card.
  show_on_cards boolean not null default false,
  latitude double precision,
  longitude double precision,
  -- ok: found; approximate: only the suburb or street matched; not_found.
  geocode_status text check (geocode_status in ('ok', 'approximate', 'not_found')),
  position double precision not null default extract(epoch from now()),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index places_household_idx on public.places (household_id);
create index places_owner_idx on public.places (owner_id);
create index places_created_by_idx on public.places (created_by);

create trigger places_household before insert on public.places
  for each row execute function private.set_household_id();
create trigger places_updated_at before update on public.places
  for each row execute function private.touch_updated_at();

create table public.travel_times (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  mode text not null check (mode in ('drive', 'transit')),
  -- Weekday trip arriving 8:30am. Drive times include a rush-hour allowance.
  duration_s integer,
  distance_m integer,
  -- "Upfield line, 1 change"
  summary text,
  status text not null default 'ok' check (status in ('ok', 'no_route', 'error')),
  -- A time one of you typed in; shown instead of duration_s and never overwritten.
  manual_s integer check (manual_s is null or manual_s between 0 and 86400),
  -- Coordinates the time was computed from, so unchanged pairs aren't recomputed.
  fingerprint text,
  computed_at timestamptz not null default now(),
  unique (property_id, place_id, mode)
);
create index travel_times_household_idx on public.travel_times (household_id);
create index travel_times_place_idx on public.travel_times (place_id);

alter table public.properties
  add column geocode_status text check (geocode_status in ('ok', 'approximate', 'not_found')),
  -- [{ "kind": "train" | "tram", "name": "Albion St/Sydney Rd", "stop_no": "26", "walk_s": 480, "distance_m": 650 }]
  add column nearest_stops jsonb check (nearest_stops is null or jsonb_typeof(nearest_stops) = 'array');

alter table public.places enable row level security;
alter table public.travel_times enable row level security;

create policy "Household reads places" on public.places
  for select to authenticated using (household_id = (select private.my_household_id()));
create policy "Household adds places" on public.places
  for insert to authenticated with check (household_id = (select private.my_household_id()));
create policy "Household edits places" on public.places
  for update to authenticated
  using (household_id = (select private.my_household_id()))
  with check (household_id = (select private.my_household_id()));
create policy "Household deletes places" on public.places
  for delete to authenticated using (household_id = (select private.my_household_id()));

-- Times are written by the function; people can only set or clear their own override.
create policy "Household reads travel times" on public.travel_times
  for select to authenticated using (household_id = (select private.my_household_id()));
create policy "Household overrides travel times" on public.travel_times
  for update to authenticated
  using (household_id = (select private.my_household_id()))
  with check (household_id = (select private.my_household_id()));
revoke insert, update, delete on public.travel_times from anon, authenticated;
grant update (manual_s) on public.travel_times to authenticated;

alter publication supabase_realtime add table public.places, public.travel_times;

-- ---------------------------------------------------------------- triggers

-- Same as call_edge_function(fn) but with a JSON body.
create or replace function private.call_edge_function(fn text, payload jsonb)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := 'https://esifddbuuyztqcqqebgx.supabase.co/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := payload,
    timeout_milliseconds := 120000
  )
$$;
revoke all on function private.call_edge_function(text, jsonb) from public, anon, authenticated;

-- A new address makes the old coordinates (and nearest stops) wrong, unless the same
-- update brings new coordinates with it (as the listing import does).
create or replace function private.clear_stale_location()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'properties' then
    if (new.address, new.suburb, new.postcode) is distinct from (old.address, old.suburb, old.postcode)
       and (new.latitude, new.longitude) is not distinct from (old.latitude, old.longitude) then
      new.latitude := null;
      new.longitude := null;
      new.geocode_status := null;
    end if;
    if (new.latitude, new.longitude) is distinct from (old.latitude, old.longitude) then
      new.nearest_stops := null;
    end if;
  elsif new.address is distinct from old.address
        and (new.latitude, new.longitude) is not distinct from (old.latitude, old.longitude) then
    new.latitude := null;
    new.longitude := null;
    new.geocode_status := null;
  end if;
  return new;
end;
$$;

create trigger properties_clear_stale_location before update on public.properties
  for each row execute function private.clear_stale_location();
create trigger places_clear_stale_location before update on public.places
  for each row execute function private.clear_stale_location();

create or replace function private.queue_travel_times()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.call_edge_function('travel-times',
    jsonb_build_object(case when tg_table_name = 'places' then 'place_id' else 'property_id' end, new.id));
  return null;
end;
$$;
revoke all on function private.queue_travel_times() from public, anon, authenticated;

-- Coordinates written by the function itself come with a new geocode_status, so they
-- don't call it a second time.
create trigger properties_queue_travel_insert after insert on public.properties
  for each row when (new.stage <> 'rejected')
  execute function private.queue_travel_times();
create trigger properties_queue_travel_update after update of address, suburb, postcode, latitude, longitude, stage on public.properties
  for each row when (
    new.stage <> 'rejected' and (
      (new.address, new.suburb, new.postcode) is distinct from (old.address, old.suburb, old.postcode)
      or ((new.latitude, new.longitude) is distinct from (old.latitude, old.longitude)
          and new.geocode_status is not distinct from old.geocode_status)
      or old.stage = 'rejected'))
  execute function private.queue_travel_times();

create trigger places_queue_travel_insert after insert on public.places
  for each row execute function private.queue_travel_times();
create trigger places_queue_travel_update after update of address, latitude, longitude on public.places
  for each row when (
    new.address is distinct from old.address
    or ((new.latitude, new.longitude) is distinct from (old.latitude, old.longitude)
        and new.geocode_status is not distinct from old.geocode_status))
  execute function private.queue_travel_times();

-- Nightly backfill: missing or failed times, and anything older than four weeks
-- (timetables change). 16:30 UTC is 3:30am Melbourne in summer.
select cron.schedule('travel-times', '30 16 * * *', $$select private.call_edge_function('travel-times')$$);
