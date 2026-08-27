-- Read-only arbitrage scanner + paper trading ledger.
--
-- Additive only: the pre-existing `trades` and `portfolio_snapshots` tables
-- (from the earlier directional "whale" strategy) are left untouched. The paper
-- equity curve reuses `portfolio_snapshots` with paper = true so the existing
-- series stays continuous.

-- One row per invocation. The only way to notice the cron dying: absence of
-- rows is the alert.
create table if not exists public.scan_runs (
  id                bigint generated always as identity primary key,
  ts                timestamptz not null default now(),
  events            integer not null default 0,
  markets           integer not null default 0,
  opportunities     integer not null default 0,
  positions_opened  integer not null default 0,
  positions_settled integer not null default 0,
  duration_ms       integer,
  ok                boolean not null default true,
  error             text
);

create index if not exists scan_runs_ts_idx on public.scan_runs (ts desc);

-- Raw book snapshots — the data-collection job. Even when no arb exists, the
-- time series of quotes is what makes any later backtest possible.
-- Append-only; pruned on a schedule (see 20260821_schedule.sql).
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
-- Sports is a query-time filter now, not a collection-time one:
--   where series_ticker like 'KXNFL%'
create index if not exists market_snapshots_series_idx
  on public.market_snapshots (series_ticker, ts desc);

-- Paper positions. One row per basket.
--
-- client_key's unique index is load-bearing: the scanner upserts on it with
-- ignoreDuplicates, so re-runs and overlapping cron firings cannot double-open
-- the same basket. No read-then-write, no race.
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
  status                   text not null default 'open',
  close_time               timestamptz,
  settled_ts               timestamptz,
  payout_cents             integer,
  realized_pnl_cents       integer
);

create index if not exists paper_positions_status_idx
  on public.paper_positions (status, opened_ts desc);

-- Every table in the public schema is exposed through PostgREST to the anon
-- role, and the anon key is public by design. RLS with no policies revokes anon
-- access entirely; the Edge Function uses the service role key, which bypasses
-- RLS, so collection is unaffected. Add explicit read policies later if a
-- dashboard needs them.
alter table public.scan_runs        enable row level security;
alter table public.market_snapshots enable row level security;
alter table public.paper_positions  enable row level security;
