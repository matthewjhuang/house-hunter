-- Web Push subscriptions (one per device), a log so each reminder goes out once,
-- and the personal tokens the iOS Shortcut uses to add listings.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);
create index push_subscriptions_household_idx on public.push_subscriptions (household_id);

create trigger push_subscriptions_household before insert on public.push_subscriptions
  for each row execute function private.set_household_id();

create table public.reminders_sent (
  inspection_id uuid not null references public.inspection_times (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (inspection_id, user_id)
);
create index reminders_sent_user_idx on public.reminders_sent (user_id);

-- Only a SHA-256 hash is stored; the token itself is shown once in Settings.
create table public.share_tokens (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);
create index share_tokens_household_idx on public.share_tokens (household_id);

create trigger share_tokens_household before insert on public.share_tokens
  for each row execute function private.set_household_id();

alter table public.push_subscriptions enable row level security;
alter table public.reminders_sent enable row level security;
alter table public.share_tokens enable row level security;

create policy "People manage their own push subscriptions" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and household_id = (select private.my_household_id()));

-- reminders_sent is written and read only by send-reminders (service role): RLS on,
-- no policies, so the API can't touch it.
revoke all on public.reminders_sent from anon, authenticated;

create policy "People see whether they have a share token" on public.share_tokens
  for select to authenticated using (user_id = (select auth.uid()));
create policy "People create their own share token" on public.share_tokens
  for insert to authenticated
  with check (user_id = (select auth.uid()) and household_id = (select private.my_household_id()));
create policy "People replace their own share token" on public.share_tokens
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and household_id = (select private.my_household_id()));
create policy "People revoke their own share token" on public.share_tokens
  for delete to authenticated using (user_id = (select auth.uid()));
