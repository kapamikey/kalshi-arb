-- Job 7/8: 5-minute cron POSTs scan then trade. Scan must never invoke /functions/v1/trade.
-- Service role from vault.kalshi_arb_service_key (never inlined).

select cron.unschedule(jobid)
from cron.job
where jobname in ('kalshi-arb-trade', 'kalshi-arb-scan');

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
    timeout_milliseconds := 55000
  );
  select net.http_post(
    url := 'https://tymnlqhakjnqwxcainwx.supabase.co/functions/v1/trade',
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
