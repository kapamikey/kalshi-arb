-- Read-only arbitrage scanner + paper trading ledger.
--
-- Additive only: the pre-existing `trades` and `portfolio_snapshots` tables
-- (used by the earlier directional "whale" strategy) are left untouched. The
-- paper equity curve reuses `portfolio_snapshots` with paper = true so the
-- existing series stays continuous.

-- One row per scanner invocation. Makes gaps in collection visible: if the cron
-- silently stops, the absence of rows is the alert.
create table if not exists public.scan_runs (
  id                bigint generated always as identity primary key,
  ts                timestamptz not null default now(),
  events_scanned    integer not null default 0,
  markets_scanned   integer not null default 0,
  sports_events     integer not null default 0,
  opportunities     integer not null default 0,
  positions_opened  integer not null default 0,
  duration_ms       integer,
  ok                boolean not null default true,
  error             text
);

create index if not exists scan_runs_ts_idx on public.scan_runs (ts desc);

-- Raw book snapshots. This is the data-collection half of the job: even when no
-- arb exists, the time series of quotes is what makes any later backtest
-- possible. Kept append-only.
create table if not exists public.market_snapshots (
  id             bigint generated always as identity primary key,
  run_id         bigint references public.scan_runs (id) on delete cascade,
  ts             timestamptz not null default now(),
  ticker         text not null,
  event_ticker   text not null,
  series_ticker  text,
  title          text,
  status         text,
  yes_bid        integer,
  yes_ask        integer,
  no_bid         integer,
  no_ask         integer,
  last_price     integer,
  volume         bigint,
  open_interest  bigint,
  liquidity      bigint,
  close_time     timestamptz
);

create index if not exists market_snapshots_ticker_ts_idx
  on public.market_snapshots (ticker, ts desc);
create index if not exists market_snapshots_ts_idx
  on public.market_snapshots (ts desc);
create index if not exists market_snapshots_event_idx
  on public.market_snapshots (event_ticker, ts desc);

-- Every opportunity the detector fires on, whether or not it is paper-traded.
-- Recording rejected ones too is what lets us tell "no edge exists" apart from
-- "our filters were too tight".
create table if not exists public.arb_opportunities (
  id                       bigint generated always as identity primary key,
  run_id                   bigint references public.scan_runs (id) on delete cascade,
  ts                       timestamptz not null default now(),
  event_ticker             text not null,
  series_ticker            text,
  title                    text,
  kind                     text not null,
  legs                     jsonb not null,
  contracts                integer not null,
  cost_cents               integer not null,
  guaranteed_payout_cents  integer not null,
  fee_cents                integer not null,
  net_edge_cents           integer not null,
  edge_bps                 integer not null,
  traded                   boolean not null default false,
  close_time               timestamptz
);

create index if not exists arb_opportunities_ts_idx
  on public.arb_opportunities (ts desc);
create index if not exists arb_opportunities_edge_idx
  on public.arb_opportunities (net_edge_cents desc);

-- Paper positions. One row per basket.
create table if not exists public.paper_positions (
  id                       bigint generated always as identity primary key,
  client_key               text not null unique,
  opened_ts                timestamptz not null default now(),
  event_ticker             text not null,
  series_ticker            text,
  title                    text,
  kind                     text not null,
  legs                     jsonb not null,
  contracts                integer not null,
  cost_cents               integer not null,
  fee_cents                integer not null,
  guaranteed_payout_cents  integer not null,
  locked_pnl_cents         integer not null,
  edge_bps                 integer not null,
  depth_verified           boolean not null default false,
  status                   text not null default 'open',
  close_time               timestamptz,
  settled_ts               timestamptz,
  payout_cents             integer,
  realized_pnl_cents       integer
);

create index if not exists paper_positions_status_idx
  on public.paper_positions (status, opened_ts desc);
create index if not exists paper_positions_event_idx
  on public.paper_positions (event_ticker);

-- Convenience view: paper book performance at a glance.
-- security_invoker is required, not cosmetic. Without it the view executes as
-- its owner and reads paper_positions with RLS bypassed, so enabling RLS on the
-- base table below would NOT stop anon from reading the ledger through here.
create or replace view public.paper_performance
  with (security_invoker = on) as
select
  count(*)                                              as positions,
  count(*) filter (where status = 'open')               as open_positions,
  count(*) filter (where status = 'settled')            as settled_positions,
  coalesce(sum(cost_cents) filter (where status = 'open'), 0)     as capital_deployed_cents,
  coalesce(sum(locked_pnl_cents) filter (where status = 'open'), 0) as unrealized_locked_cents,
  coalesce(sum(realized_pnl_cents) filter (where status = 'settled'), 0) as realized_pnl_cents,
  coalesce(sum(fee_cents), 0)                           as fees_paid_cents
from public.paper_positions;

-- Every table in the public schema is exposed through PostgREST to the anon
-- role, and the anon key is public by design. RLS with no policies revokes anon
-- access entirely; the Edge Function uses the service role key, which bypasses
-- RLS, so collection is unaffected. Add explicit read policies later if a
-- dashboard needs them.
alter table public.scan_runs         enable row level security;
alter table public.market_snapshots  enable row level security;
alter table public.arb_opportunities enable row level security;
alter table public.paper_positions   enable row level security;
