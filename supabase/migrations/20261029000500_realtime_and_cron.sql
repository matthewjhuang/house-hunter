-- Realtime for everything that should appear live on the other phone, plus the two
-- scheduled jobs. The jobs call Edge Functions over pg_net with a shared secret kept
-- in Vault; the functions check it with public.verify_cron_secret (service role only).

alter publication supabase_realtime add table
  public.properties,
  public.comments,
  public.checklist_items,
  public.inspection_times,
  public.property_changes,
  public.households,
  public.household_members;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret', 'Shared secret for scheduled Edge Function calls');

create or replace function public.verify_cron_secret(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets where name = 'cron_secret' and decrypted_secret = candidate
  )
$$;
revoke all on function public.verify_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_cron_secret(text) to service_role;

create or replace function private.call_edge_function(fn text)
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
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
$$;
revoke all on function private.call_edge_function(text) from public, anon, authenticated;

-- Inspection reminders: every 5 minutes.
select cron.schedule('send-reminders', '*/5 * * * *', $$select private.call_edge_function('send-reminders')$$);
-- Listing re-check: daily at 19:00 UTC (6am Melbourne in summer, 5am in winter).
select cron.schedule('recheck-listings', '0 19 * * *', $$select private.call_edge_function('recheck-listings')$$);
