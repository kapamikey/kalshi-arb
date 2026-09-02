-- Version-control live schema on tymnlqhakjnqwxcainwx.
-- Idempotent: objects may already exist. Do not create portfolio_snapshots.
-- 1-lot is contracts=1 (no product named "nano plan").
-- Kalshi taker fee: ceil(M * 0.07 * C * P_cents * (100-P_cents) / 100).

create index if not exists market_snapshots_run_id_ticker_idx
  on public.market_snapshots (run_id, ticker);

create or replace view public.market_snapshots_latest
with (security_invoker = true) as
select s.*
from public.market_snapshots s
where s.run_id = (select id from public.scan_runs order by ts desc limit 1);

grant select on public.market_snapshots_latest to anon, authenticated;

create or replace function public.prune_old_scan_runs(keep_hours integer default 24)
returns integer
language plpgsql
as $$
declare
  deleted integer;
begin
  with gone as (
    delete from public.scan_runs s
    where s.ts < now() - make_interval(hours => greatest(keep_hours, 1))
    returning 1
  )
  select count(*)::int into deleted from gone;
  return coalesce(deleted, 0);
end;
$$;

comment on function public.prune_old_scan_runs(integer) is
  'Delete scan_runs older than keep_hours; market_snapshots cascade. Default 24h.';

do $$
begin
  if exists (select 1 from cron.job where jobname = 'kalshi-arb-prune-old-runs') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'kalshi-arb-prune-old-runs';
  end if;
  perform cron.schedule(
    'kalshi-arb-prune-old-runs',
    '*/15 * * * *',
    $cron$select public.prune_old_scan_runs(24)$cron$
  );
end;
$$;

create or replace function public.kalshi_taker_fee_cents(
  contracts integer,
  price_cents integer,
  fee_multiplier numeric default 1,
  fee_rate numeric default 0.07
) returns integer
language sql
immutable
as $$
  select case
    when contracts is null or contracts <= 0 or price_cents is null then 0
    when price_cents <= 0 or price_cents >= 100 then 0
    else ceil(
      coalesce(nullif(fee_multiplier, 0), 1)
      * fee_rate
      * contracts
      * price_cents
      * (100 - price_cents)
      / 100.0
    )::integer
  end;
$$;

alter table public.paper_positions
  add column if not exists confidence integer,
  add column if not exists result text;

alter table public.paper_positions drop constraint if exists paper_positions_confidence_check;
alter table public.paper_positions
  add constraint paper_positions_confidence_check
  check (confidence is null or (confidence between 1 and 10));

alter table public.paper_positions drop constraint if exists paper_positions_result_check;
alter table public.paper_positions
  add constraint paper_positions_result_check
  check (result is null or result in ('win','loss','open','flat'));

update public.paper_positions
set result = case
  when status is distinct from 'settled' then 'open'
  when coalesce(realized_pnl_cents, 0) > 0 then 'win'
  when coalesce(realized_pnl_cents, 0) < 0 then 'loss'
  else 'flat'
end
where result is null;

create or replace function public.paper_positions_set_result()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from 'settled' then
    new.result := 'open';
  elsif coalesce(new.realized_pnl_cents, 0) > 0 then
    new.result := 'win';
  elsif coalesce(new.realized_pnl_cents, 0) < 0 then
    new.result := 'loss';
  else
    new.result := 'flat';
  end if;
  return new;
end;
$$;

drop trigger if exists paper_positions_set_result on public.paper_positions;
create trigger paper_positions_set_result
  before insert or update of status, realized_pnl_cents
  on public.paper_positions
  for each row execute function public.paper_positions_set_result();

alter table public.demo_orders
  add column if not exists contracts integer not null default 1,
  add column if not exists price_cents integer,
  add column if not exists fee_cents integer not null default 0,
  add column if not exists fee_multiplier numeric,
  add column if not exists fee_type text,
  add column if not exists realized_pnl_cents integer,
  add column if not exists result text,
  add column if not exists confidence integer;

alter table public.demo_orders drop constraint if exists demo_orders_contracts_check;
alter table public.demo_orders
  add constraint demo_orders_contracts_check check (contracts >= 1);

alter table public.demo_orders drop constraint if exists demo_orders_fee_type_check;
alter table public.demo_orders
  add constraint demo_orders_fee_type_check
  check (fee_type is null or fee_type in (
    'quadratic','quadratic_with_maker_fees','quadratic_with_combo_maker_fees','flat'
  ));

alter table public.demo_orders drop constraint if exists demo_orders_result_check;
alter table public.demo_orders
  add constraint demo_orders_result_check
  check (result is null or result in ('win','loss','open','flat','rejected'));

alter table public.demo_orders drop constraint if exists demo_orders_confidence_check;
alter table public.demo_orders
  add constraint demo_orders_confidence_check
  check (confidence is null or (confidence between 1 and 10));

create or replace view public.paper_ledger_totals
with (security_invoker = true) as
select
  count(*) filter (where result = 'win') as wins,
  count(*) filter (where result = 'loss') as losses,
  count(*) filter (where result = 'flat') as flats,
  count(*) filter (where coalesce(result, 'open') = 'open') as open_count,
  coalesce(sum(realized_pnl_cents), 0) as net_pnl_cents,
  coalesce(sum(fee_cents), 0) as fee_cents_total,
  coalesce(sum(contracts), 0) as contracts_total
from public.paper_positions;

create or replace view public.demo_order_ledger_totals
with (security_invoker = true) as
select
  count(*) filter (where result = 'win') as wins,
  count(*) filter (where result = 'loss') as losses,
  count(*) filter (where result = 'flat') as flats,
  count(*) filter (where coalesce(result, 'open') = 'open') as open_count,
  count(*) filter (where result = 'rejected') as rejected,
  coalesce(sum(realized_pnl_cents), 0) as net_pnl_cents,
  coalesce(sum(fee_cents), 0) as fee_cents_total,
  coalesce(sum(contracts), 0) as contracts_total
from public.demo_orders;

grant select on public.paper_ledger_totals to anon, authenticated;
grant select on public.demo_order_ledger_totals to anon, authenticated;

create index if not exists paper_positions_status_settled_idx
  on public.paper_positions (status, settled_ts desc);
create index if not exists paper_positions_result_idx
  on public.paper_positions (result);
create index if not exists demo_orders_ts_idx
  on public.demo_orders (ts desc);
create index if not exists demo_orders_result_idx
  on public.demo_orders (result);
