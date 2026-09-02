-- Free-plan disk: keep market_snapshots for the newest 6 scan_runs only.
-- scan_runs rows still live until prune_old_scan_runs(24). Dashboard uses market_snapshots_latest.
-- Idempotent. Do not create portfolio_snapshots.

create or replace function public.prune_extra_snapshot_history(keep_n integer default 6)
returns integer
language plpgsql
as $$
declare
  deleted integer;
begin
  with keep as (
    select id from public.scan_runs order by ts desc limit greatest(keep_n, 1)
  ),
  gone as (
    delete from public.market_snapshots s
    where not exists (select 1 from keep k where k.id = s.run_id)
    returning 1
  )
  select count(*)::int into deleted from gone;
  return coalesce(deleted, 0);
end;
$$;

comment on function public.prune_extra_snapshot_history(integer) is
  'Keep market_snapshots for the newest N scan_runs only (default 6). scan_runs rows stay until 24h prune. Free-plan disk.';

do $$
begin
  if exists (select 1 from cron.job where jobname = 'kalshi-arb-prune-snapshot-history') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'kalshi-arb-prune-snapshot-history';
  end if;
  perform cron.schedule(
    'kalshi-arb-prune-snapshot-history',
    '*/15 * * * *',
    $cron$select public.prune_extra_snapshot_history(6)$cron$
  );
end;
$$;
