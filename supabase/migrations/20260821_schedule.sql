-- Schedules the scanner. Run AFTER 20260821_arb_scanner.sql and after the
-- `scan` Edge Function is deployed.
--
-- The service role key comes from Vault rather than being inlined, so it never
-- appears in the cron job definition.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One-time secret setup. Run it once with the real key, then delete this line
-- from your local copy:
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'kalshi_arb_service_key');

-- Every 5 minutes.
--
-- Be honest about what this cadence can and cannot do: a genuine cross-outcome
-- arb on a liquid book is closed by other participants in seconds. A 5-minute
-- poll will almost never *catch* one — what it reliably builds is the quote
-- history in market_snapshots, which is what tells you whether exploitable
-- spreads exist at all and at what size. Treat this as measurement first and
-- opportunity capture second; capture needs a streaming feed, not a cron.
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

-- Housekeeping. market_snapshots gains one row per open market per run. Across
-- all of Kalshi on a 5-minute cadence that is order-of 10^5-10^6 rows/day, so
-- this prune is not optional. Shorten the interval if storage bites.
select cron.schedule(
  'kalshi-arb-prune-snapshots',
  '0 4 * * *',
  $$delete from public.market_snapshots where ts < now() - interval '30 days'$$
);

-- Inspect or remove:
--   select * from cron.job;
--   select cron.unschedule('kalshi-arb-scan');
