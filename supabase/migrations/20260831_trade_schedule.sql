-- 30-second demo trader cron. Run AFTER 20260831_demo_orders.sql and after
-- the `trade` Edge Function is deployed.
--
-- Timeout stays under the existing 55s cap. Trading stays off until
-- KALSHI_TRADING_ENABLED=true is set in Edge Function secrets (Vault).
--
-- Enable (idempotent-ish): this migration schedules the job. Inspect / remove:
--   select * from cron.job;
--   select cron.unschedule('kalshi-arb-trade');
--
-- Re-enable later without re-running the whole migration:
--   select cron.schedule(
--     'kalshi-arb-trade',
--     '30 seconds',
--     $$ ... $$
--   );

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'kalshi-arb-trade';

select cron.schedule(
  'kalshi-arb-trade',
  '30 seconds',
  $$
  select net.http_post(
    url := 'https://axdikbsghdotugnotzof.supabase.co/functions/v1/trade',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'kalshi_arb_service_key'
      )
    ),
    timeout_milliseconds := 50000
  );
  $$
);
