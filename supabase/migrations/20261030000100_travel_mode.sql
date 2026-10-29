-- Each person's usual way to get around (Matthew drives, Hannah takes public
-- transport), and each place's own setting, which starts as its owner's. Cards show
-- the time for that mode; the property sheet shows it first. Both modes are still
-- computed for every place.

alter table public.household_members
  add column travel_mode text not null default 'transit' check (travel_mode in ('drive', 'transit'));
alter table public.household_invites
  add column travel_mode text not null default 'transit' check (travel_mode in ('drive', 'transit'));
alter table public.places
  add column travel_mode text not null default 'transit' check (travel_mode in ('drive', 'transit'));

update public.household_invites set travel_mode = 'drive' where email = 'matthewjhuang@gmail.com';
update public.household_members set travel_mode = 'drive' where email = 'matthewjhuang@gmail.com';
update public.places set travel_mode = 'drive'
  where owner_id in (select user_id from public.household_members where travel_mode = 'drive');

-- The invite's travel mode carries over when someone creates their account.
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
  insert into public.household_members (household_id, user_id, display_name, email, travel_mode)
  values (invite.household_id, new.id, invite.display_name, lower(new.email), invite.travel_mode)
  on conflict do nothing;
  return new;
end;
$$;
