-- Demo paper-trader ledger. Real Kalshi demo fills, not the simulated
-- paper_positions book. Anon SELECT only; the trader writes with the
-- service role, which bypasses RLS.

create table if not exists public.demo_baskets (
  id                       bigint generated always as identity primary key,
  client_key               text not null unique,
  opened_ts                timestamptz not null default now(),
  updated_ts               timestamptz not null default now(),
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
  status                   text not null default 'submitted'
                           check (status in ('submitted', 'filled', 'partial', 'failed', 'canceled')),
  fail_reason              text,
  close_time               timestamptz,
  realized_pnl_cents       integer
);
create index if not exists demo_baskets_opened_idx on public.demo_baskets (opened_ts desc);

create table if not exists public.demo_orders (
  id               bigint generated always as identity primary key,
  basket_id        bigint not null references public.demo_baskets (id) on delete cascade,
  client_order_id  text not null unique,
  kalshi_order_id  text,
  ticker           text not null,
  side             text not null,
  book_side        text,
  price_cents      integer not null,
  contracts        integer not null,
  filled_count     numeric not null default 0,
  remaining_count  numeric not null default 0,
  status           text not null default 'submitted'
                   check (status in ('submitted', 'filled', 'partial', 'failed', 'canceled')),
  reject_reason    text,
  time_in_force    text not null,
  submitted_ts     timestamptz not null default now(),
  updated_ts       timestamptz not null default now()
);
create index if not exists demo_orders_basket_idx on public.demo_orders (basket_id);

create table if not exists public.demo_fills (
  id              bigint generated always as identity primary key,
  basket_id       bigint not null references public.demo_baskets (id) on delete cascade,
  order_id        bigint references public.demo_orders (id) on delete set null,
  kalshi_fill_id  text,
  ticker          text not null,
  side            text not null,
  price_cents     integer not null,
  count           numeric not null,
  ts              timestamptz not null default now()
);
create index if not exists demo_fills_basket_idx on public.demo_fills (basket_id);

create table if not exists public.demo_trader_status (
  id                   integer primary key default 1 check (id = 1),
  trading_enabled      boolean not null default false,
  env                  text not null default 'demo',
  rest_host            text,
  last_heartbeat       timestamptz not null default now(),
  trying_event_ticker  text,
  last_error           text
);
insert into public.demo_trader_status (id, trading_enabled, env) values (1, false, 'demo') on conflict (id) do nothing;

alter table public.demo_baskets       enable row level security;
alter table public.demo_orders        enable row level security;
alter table public.demo_fills         enable row level security;
alter table public.demo_trader_status enable row level security;

create policy "anon_select_demo_baskets" on public.demo_baskets for select to anon using (true);
create policy "anon_select_demo_orders" on public.demo_orders for select to anon using (true);
create policy "anon_select_demo_fills" on public.demo_fills for select to anon using (true);
create policy "anon_select_demo_trader_status" on public.demo_trader_status for select to anon using (true);
