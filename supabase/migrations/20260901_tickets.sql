-- Human ticket desk. Scanner writes open rows; humans skip/approve.
-- Anon SELECT only. Edge Functions write with the service role (bypasses RLS).
-- Cron must not POST orders; Approve is a separate function.

create table if not exists public.tickets (
  id                      bigint generated always as identity primary key,
  event_ticker            text not null,
  title                   text,
  kind                    text not null,
  legs                    jsonb not null,
  quoted_ts               timestamptz not null,
  fee_cents               integer not null,
  net_edge_cents          integer not null,
  optimistic_pnl_cents    integer not null,
  conservative_pnl_cents  integer,
  status                  text not null,
  demo_order_ids          bigint[],
  constraint tickets_status_check
    check (status in ('open', 'skipped', 'approved', 'expired'))
);

create index if not exists tickets_open_quoted_idx
  on public.tickets (status, quoted_ts desc);

create index if not exists tickets_quoted_idx
  on public.tickets (quoted_ts desc);

alter table public.tickets enable row level security;

drop policy if exists "anon_select_tickets" on public.tickets;
create policy "anon_select_tickets"
  on public.tickets
  for select
  to anon
  using (true);
