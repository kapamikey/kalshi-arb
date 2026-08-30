-- Dashboard read path. Anon SELECT only; the Edge Function still writes
-- with the service role, which bypasses RLS.
--
-- Additive: no column changes, no writes, no touch of trades.
-- portfolio_snapshots is not altered here. The UI reads paper=true
-- rows if PostgREST already allows it, otherwise derives equity
-- from paper_positions so whale history stays untouched.

create policy "anon_select_scan_runs"
  on public.scan_runs
  for select
  to anon
  using (true);

create policy "anon_select_paper_positions"
  on public.paper_positions
  for select
  to anon
  using (true);

create policy "anon_select_market_snapshots"
  on public.market_snapshots
  for select
  to anon
  using (true);
