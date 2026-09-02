-- Scan cron posts /functions/v1/scan only. Trade is invoked once from scan.
-- Unschedule leftover kalshi-arb-trade if present.
-- timeout 150s so scan + one nested trade (~50s) can finish on the 5-minute loop.

select cron.unschedule(jobid)
from cron.job
where jobname = 'kalshi-arb-trade';

select cron.unschedule(jobid)
from cron.job
where jobname = 'kalshi-arb-scan';

select cron.schedule(
  'kalshi-arb-scan',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://tymnlqhakjnqwxcainwx.supabase.co/functions/v1/scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'kalshi_arb_service_key'
      )
    ),
    timeout_milliseconds := 150000
  );
  $$
);
