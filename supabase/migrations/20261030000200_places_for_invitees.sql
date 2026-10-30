-- Places can belong to someone who's invited but hasn't created their account yet
-- (Matthew adding Hannah's work before she signs up). owner_invite holds their invite
-- email; when they sign up, their places move over to owner_id.

alter table public.places
  add column owner_invite text references public.household_invites (email) on update cascade on delete set null,
  add constraint places_one_owner check (owner_id is null or owner_invite is null);
create index places_owner_invite_idx on public.places (owner_invite);

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
  update public.places set owner_id = new.id, owner_invite = null
  where owner_invite = invite.email and household_id = invite.household_id;
  return new;
end;
$$;
