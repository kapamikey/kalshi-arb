-- Product lock: one 5-minute loop. Scan cron stays; after each scan the
-- scan function POSTs /functions/v1/trade once (service-role Bearer, ~50s
-- timeout). Do not keep a dedicated trade cron (was 30 seconds, then */5).
--
-- Inspect:
--   select jobname, schedule from cron.job;
-- Re-drop if it comes back:
--   select cron.unschedule(jobid) from cron.job where jobname = 'kalshi-arb-trade';

select cron.unschedule(jobid)
from cron.job
where jobname = 'kalshi-arb-trade';
