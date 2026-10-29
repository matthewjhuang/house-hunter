-- Households: exactly two people share one, and every other table is scoped to it.
-- Joining is invite-only: a new auth user whose email isn't in household_invites is
-- rejected by the trigger at the bottom, and an invited one is added to that household.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our household',
  max_rent_pw integer check (max_rent_pw is null or max_rent_pw > 0),
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  email text not null,
  reminder_lead_minutes integer not null default 60 check (reminder_lead_minutes between 5 and 1440),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
-- One household per person keeps every policy a simple equality check.
create unique index household_members_user_id_key on public.household_members (user_id);

create table public.household_invites (
  email text primary key check (email = lower(email)),
  household_id uuid not null references public.households (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);
create index household_invites_household_id_idx on public.household_invites (household_id);

-- The signed-in user's household. security definer so policies on household_members
-- itself don't recurse.
create or replace function private.my_household_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select household_id from public.household_members where user_id = (select auth.uid())
$$;
revoke all on function private.my_household_id() from public, anon;
grant execute on function private.my_household_id() to authenticated;

-- Fills household_id on insert so the app never has to send it. Edge Functions
-- (service role, no auth.uid()) always set it themselves.
create or replace function private.set_household_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.household_id is null then
    new.household_id := private.my_household_id();
  end if;
  return new;
end;
$$;
revoke all on function private.set_household_id() from public, anon;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;

create policy "Members read their household" on public.households
  for select to authenticated using (id = (select private.my_household_id()));
create policy "Members update their household" on public.households
  for update to authenticated
  using (id = (select private.my_household_id()))
  with check (id = (select private.my_household_id()));

create policy "Members read each other" on public.household_members
  for select to authenticated using (household_id = (select private.my_household_id()));
create policy "Members update their own row" on public.household_members
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and household_id = (select private.my_household_id()));

create policy "Members read their invites" on public.household_invites
  for select to authenticated using (household_id = (select private.my_household_id()));

-- Invite gate. Raising here makes Supabase Auth refuse the sign-up, so an uninvited
-- email never gets an account (the app shows "This email isn't on the invite list").
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite public.household_invites;
begin
  select * into invite from public.household_invites where email = lower(new.email);
  if not found then
    raise exception 'not_invited: % is not on the House Hunter invite list', new.email;
  end if;
  insert into public.household_members (household_id, user_id, display_name, email)
  values (invite.household_id, new.id, invite.display_name, lower(new.email))
  on conflict do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- The one household and its two invites.
with h as (
  insert into public.households (name) values ('Matthew & Hannah') returning id
)
insert into public.household_invites (email, household_id, display_name)
select v.email, h.id, v.display_name
from h, (values ('matthewjhuang@gmail.com', 'Matthew'), ('hannahhuange@gmail.com', 'Hannah')) as v (email, display_name);
