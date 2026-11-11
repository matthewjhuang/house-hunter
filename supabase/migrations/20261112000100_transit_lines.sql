-- Public transport lines near each listing, replacing the single nearest station and
-- tram stop. One entry per tram or bus route (at its closest stop) and per train
-- station, with the walk, how often it runs in the 7:30-8:30am weekday peak, and the
-- last service each way on a weeknight. Worked out by travel-times from Transitous
-- (PTV's timetables) and refreshed every four weeks. About 1-2 KB per listing.
--
-- { "version": "2026-11-12",
--   "lines": [{ "mode": "train" | "tram" | "bus", "route": "109",
--               "stop": { "name": "Charles St/Cotham Rd", "no": "35", "lat": …, "lon": … },
--               "walk_s": 540, "distance_m": 680,
--               "dirs": [{ "to": "Port Melbourne", "city": true, "peak": 13,
--                          "last": "2026-11-18T14:37:00Z" }, …] }] }

alter table public.properties
  add column transit jsonb check (transit is null or jsonb_typeof(transit) = 'object'),
  drop column nearest_stops;

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
      new.transit := null;
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
