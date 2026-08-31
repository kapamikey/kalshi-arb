-- Anon SELECT for paper equity. The dashboard reads the latest
-- portfolio_snapshots row where paper = true.
--
-- 20260830_dashboard_read.sql left this table untouched so whale
-- (paper = false) history stayed private. After that, a failed/blocked
-- read showed "—" even when the scanner had written a paper equity point.
--
-- Additive: no column changes, no writes. Service role still bypasses RLS.
-- Apply with: supabase db push
--   (or paste this file into the Supabase SQL editor)

alter table public.portfolio_snapshots enable row level security;

drop policy if exists "anon_select_paper_portfolio_snapshots" on public.portfolio_snapshots;

create policy "anon_select_paper_portfolio_snapshots"
  on public.portfolio_snapshots
  for select
  to anon
  using (paper = true);

-- This table predates the scanner; grant in case default privileges were never set.
grant select on public.portfolio_snapshots to anon;
