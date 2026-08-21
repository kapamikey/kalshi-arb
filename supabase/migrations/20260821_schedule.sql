-- Schedules the scanner. Run this AFTER 20260821_arb_scanner.sql and after the
-- `scan` Edge Function is deployed.
--
-- Requires the pg_cron and pg_net extensions (both available on Supabase; enable
-- them under Database > Extensions if they aren't already).
--
-- The service role key is read from Vault rather than inlined, so it never
-- appears in the cron job definition, which is world-readable to anyone with
-- database access.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One-time secret setup. Replace the placeholder with the project's service role
-- key, run it once, then delete this statement from your local copy.
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'kalshi_arb_service_key');

-- Every 5 minutes. Kalshi's books on in-play games move faster than that, but
-- 5m is a reasonable balance between snapshot density and Edge Function
-- invocation count. Tighten to '* * * * *' if you want minute bars.
select cron.schedule(
  'kalshi-arb-scan',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://axdikbsghdotugnotzof.supabase.co/functions/v1/scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'kalshi_arb_service_key'
      )
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- Housekeeping: market_snapshots grows by roughly (sports markets) rows every
-- run. At ~500 sports markets on a 5-minute cadence that is ~144k rows/day, so
-- prune aggressively unless you are deliberately building a long history.
select cron.schedule(
  'kalshi-arb-prune-snapshots',
  '0 4 * * *',
  $$delete from public.market_snapshots where ts < now() - interval '30 days'$$
);

-- To inspect or remove:
--   select * from cron.job;
--   select cron.unschedule('kalshi-arb-scan');
