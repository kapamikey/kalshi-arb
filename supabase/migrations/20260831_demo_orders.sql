-- Demo paper-trading blotter. One table this week.
--
-- Sentinel row (basket_id = '__trader__', client_order_id = 'trader-status')
-- holds the latest trader sentence for the dashboard. Real orders never use
-- that basket id. Do not create demo_fills / demo_baskets. Do not write
-- these rows into paper_positions.

create table if not exists public.demo_orders (
  id                bigint generated always as identity primary key,
  basket_id         text not null,
  ticker            text not null,
  side              text not null,
  status            text not null,
  kalshi_order_id   text,
  reject_reason     text,
  ts                timestamptz not null default now(),
  event_ticker      text,
  kind              text,
  client_order_id   text not null
);

create unique index if not exists demo_orders_client_order_id_idx
  on public.demo_orders (client_order_id);

create index if not exists demo_orders_ts_idx
  on public.demo_orders (ts desc);

create index if not exists demo_orders_basket_idx
  on public.demo_orders (basket_id, ts desc);

alter table public.demo_orders enable row level security;

drop policy if exists "anon_select_demo_orders" on public.demo_orders;
create policy "anon_select_demo_orders"
  on public.demo_orders
  for select
  to anon
  using (true);
