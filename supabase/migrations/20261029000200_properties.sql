-- Properties (one card per rental, however many sites list it), their change history
-- from the daily re-check, and inspection times.

create type public.stage as enum (
  'saved', 'inspection_booked', 'inspected', 'applied', 'approved', 'lease_signed', 'rejected'
);
create type public.reject_reason as enum (
  'too_far', 'too_expensive', 'condition', 'missed_out', 'agent_rejected', 'other'
);
create type public.listing_status as enum ('active', 'under_application', 'leased', 'removed');
-- ok: every key field parsed; partial: some missing; blocked: the site refused us;
-- manual: entered by hand.
create type public.parse_status as enum ('ok', 'partial', 'blocked', 'manual');

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  stage public.stage not null default 'saved',
  -- Order within a column; new cards go to the top (largest first).
  position double precision not null default extract(epoch from now()),
  rejected_reason public.reject_reason,
  rejected_note text,
  rejected_from_stage public.stage,

  title text,
  address text,
  suburb text,
  state text,
  postcode text,
  -- Normalised address ("12/34 smith st brunswick 3056"), used to merge the same
  -- property arriving from REA and Domain into one card.
  address_key text,
  latitude double precision,
  longitude double precision,

  rent_pw integer check (rent_pw is null or rent_pw >= 0),
  bond integer check (bond is null or bond >= 0),
  beds smallint,
  baths smallint,
  cars smallint,
  property_type text,
  available_date date,
  description text,

  agent_name text,
  agency text,
  agent_phone text,
  agent_email text,

  -- Original image URLs only; nothing is copied into Storage.
  photo_urls text[] not null default '{}',
  -- [{ "site": "realestate.com.au", "url": "...", "listing_id": "1234" }]
  sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),

  listing_status public.listing_status not null default 'active',
  parse_status public.parse_status not null default 'manual',
  missing_fields text[] not null default '{}',
  last_checked_at timestamptz,
  has_unseen_changes boolean not null default false,

  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index properties_household_address_key
  on public.properties (household_id, address_key) where address_key is not null;
create index properties_household_stage_idx on public.properties (household_id, stage);
create index properties_created_by_idx on public.properties (created_by);

create trigger properties_household before insert on public.properties
  for each row execute function private.set_household_id();
create trigger properties_updated_at before update on public.properties
  for each row execute function private.touch_updated_at();

create table public.property_changes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  kind text not null check (kind in ('price', 'status', 'removed')),
  old_value text,
  new_value text,
  detected_at timestamptz not null default now()
);
create index property_changes_property_idx on public.property_changes (property_id, detected_at desc);
create index property_changes_household_idx on public.property_changes (household_id);

create table public.inspection_times (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz,
  booked boolean not null default false,
  origin text not null default 'manual' check (origin in ('parsed', 'manual')),
  created_at timestamptz not null default now(),
  unique (property_id, starts_at)
);
create index inspection_times_household_idx on public.inspection_times (household_id);
create index inspection_times_booked_idx on public.inspection_times (starts_at) where booked;

create trigger inspection_times_household before insert on public.inspection_times
  for each row execute function private.set_household_id();

alter table public.properties enable row level security;
alter table public.property_changes enable row level security;
alter table public.inspection_times enable row level security;

create policy "Household reads properties" on public.properties
  for select to authenticated using (household_id = (select private.my_household_id()));
create policy "Household adds properties" on public.properties
  for insert to authenticated with check (household_id = (select private.my_household_id()));
create policy "Household edits properties" on public.properties
  for update to authenticated
  using (household_id = (select private.my_household_id()))
  with check (household_id = (select private.my_household_id()));
create policy "Household deletes properties" on public.properties
  for delete to authenticated using (household_id = (select private.my_household_id()));

-- Changes are written only by the re-check function (service role).
create policy "Household reads changes" on public.property_changes
  for select to authenticated using (household_id = (select private.my_household_id()));

create policy "Household reads inspections" on public.inspection_times
  for select to authenticated using (household_id = (select private.my_household_id()));
create policy "Household adds inspections" on public.inspection_times
  for insert to authenticated with check (household_id = (select private.my_household_id()));
create policy "Household edits inspections" on public.inspection_times
  for update to authenticated
  using (household_id = (select private.my_household_id()))
  with check (household_id = (select private.my_household_id()));
create policy "Household deletes inspections" on public.inspection_times
  for delete to authenticated using (household_id = (select private.my_household_id()));
