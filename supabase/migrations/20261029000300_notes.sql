-- Comments and the inspection checklist. Every new property gets the default
-- checklist; either person can add custom items afterwards.

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  author_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index comments_property_idx on public.comments (property_id, created_at);
create index comments_household_idx on public.comments (household_id);
create index comments_author_idx on public.comments (author_id);

create trigger comments_household before insert on public.comments
  for each row execute function private.set_household_id();

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 120),
  position integer not null default 0,
  rating text check (rating in ('good', 'okay', 'bad')),
  note text,
  is_custom boolean not null default true,
  updated_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index checklist_items_property_idx on public.checklist_items (property_id, position);
create index checklist_items_household_idx on public.checklist_items (household_id);
create index checklist_items_updated_by_idx on public.checklist_items (updated_by);

create trigger checklist_items_household before insert on public.checklist_items
  for each row execute function private.set_household_id();
create trigger checklist_items_updated_at before update on public.checklist_items
  for each row execute function private.touch_updated_at();

create or replace function private.seed_checklist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.checklist_items (household_id, property_id, label, position, is_custom, updated_by)
  select new.household_id, new.id, t.label, t.ord, false, null
  from unnest(array[
    'Water pressure',
    'Mould and damp',
    'Natural light',
    'Noise',
    'Heating and cooling',
    'Storage',
    'Phone reception',
    'Kitchen condition',
    'Bathroom condition',
    'Security',
    'Parking'
  ]) with ordinality as t (label, ord);
  return new;
end;
$$;
revoke all on function private.seed_checklist() from public, anon, authenticated;

create trigger properties_seed_checklist after insert on public.properties
  for each row execute function private.seed_checklist();

alter table public.comments enable row level security;
alter table public.checklist_items enable row level security;

create policy "Household reads comments" on public.comments
  for select to authenticated using (household_id = (select private.my_household_id()));
create policy "Members add their own comments" on public.comments
  for insert to authenticated
  with check (household_id = (select private.my_household_id()) and author_id = (select auth.uid()));
create policy "Authors edit their comments" on public.comments
  for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()) and household_id = (select private.my_household_id()));
create policy "Authors delete their comments" on public.comments
  for delete to authenticated using (author_id = (select auth.uid()));

create policy "Household reads checklist" on public.checklist_items
  for select to authenticated using (household_id = (select private.my_household_id()));
create policy "Household adds checklist items" on public.checklist_items
  for insert to authenticated with check (household_id = (select private.my_household_id()));
create policy "Household edits checklist" on public.checklist_items
  for update to authenticated
  using (household_id = (select private.my_household_id()))
  with check (household_id = (select private.my_household_id()));
create policy "Household deletes custom checklist items" on public.checklist_items
  for delete to authenticated using (household_id = (select private.my_household_id()) and is_custom);
