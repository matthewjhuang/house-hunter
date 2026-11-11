-- Nearby: each active listing's closest Coles, Woolworths, Aldi, Chemist Warehouse and
-- park, with walk and car times. Worked out by travel-times from nearby/nearby.json in
-- the GitHub repo, so the stores and parks themselves aren't stored here (a few hundred
-- bytes per listing instead of ~1 MB).
--
-- { "version": "2026-11-11",   -- the data file's date; a newer file means recompute
--   "items": [{ "kind": "coles" | "woolworths" | "aldi" | "chemist_warehouse" | "park",
--               "name": "Coles Local", "lat": …, "lon": …, "distance_m": 950,
--               "walk_s": 720, "drive_s": 300, "ha": 5.0 }] }

alter table public.properties
  add column nearby jsonb check (nearby is null or jsonb_typeof(nearby) = 'object');

-- New coordinates make nearby stale too, like the nearest stops.
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
      new.nearby := null;
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

-- Storage: pg_cron logs every run (send-reminders alone is 288 a day). Keep a week.
select cron.schedule('prune-cron-log', '15 17 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
