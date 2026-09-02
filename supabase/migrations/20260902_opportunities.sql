-- Version the LIVE public.opportunities shape (project tymnlqhakjnqwxcainwx).
-- Table already exists; this is create-if-not-exists only. No extra columns.
-- No portfolio_snapshots.

create table if not exists public.opportunities (
  id                 bigint generated always as identity primary key,
  ts                 timestamptz not null default now(),
  run_id             bigint null references public.scan_runs (id) on delete set null,
  event_ticker       text not null,
  tickers            text[] not null default '{}',
  modeled_ev_cents   integer not null,
  fee_cents          integer not null default 0,
  decision           text not null,
  reason             text null,
  confidence         integer null,
  result             text null,
  demo_order_id      bigint null references public.demo_orders (id) on delete set null,
  paper_position_id  bigint null references public.paper_positions (id) on delete set null,
  constraint opportunities_decision_check
    check (decision = any (array['taken'::text, 'skipped'::text])),
  constraint opportunities_confidence_check
    check ((confidence is null) or ((confidence >= 1) and (confidence <= 10))),
  constraint opportunities_result_check
    check ((result is null) or (result = any (array['win'::text, 'loss'::text, 'open'::text, 'flat'::text, 'rejected'::text])))
);

comment on table public.opportunities is
  'One row per scan candidate. Tiny vs market_snapshots. Fill/result linked when taken. Demo only.';

create index if not exists opportunities_ts_idx
  on public.opportunities (ts desc);
create index if not exists opportunities_event_ts_idx
  on public.opportunities (event_ticker, ts desc);
create index if not exists opportunities_run_id_idx
  on public.opportunities (run_id);
create index if not exists opportunities_decision_idx
  on public.opportunities (decision);

alter table public.opportunities enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policy
    where polname = 'anon_select_opportunities'
      and polrelid = 'public.opportunities'::regclass
  ) then
    create policy "anon_select_opportunities"
      on public.opportunities
      for select
      to anon
      using (true);
  end if;
end
$$;
