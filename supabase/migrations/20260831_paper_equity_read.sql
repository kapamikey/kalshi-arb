-- Dashboard paper-equity read path.
-- Anon SELECT on portfolio_snapshots, paper=true rows only.
-- 20260830_dashboard_read.sql left this table untouched so whale history
-- stayed private; the scanner still writes paper=true equity points with
-- the service role. Without this policy the dashboard health strip shows
-- a blank paper equity after a healthy scan.
--
-- Additive: no column changes, no writes, no touch of trades.
-- Apply in the Supabase SQL editor or `supabase db push`.

alter table public.portfolio_snapshots enable row level security;

create policy "anon_select_paper_portfolio_snapshots"
  on public.portfolio_snapshots
  for select
  to anon
  using (paper is true);
