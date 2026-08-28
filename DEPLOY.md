# Deploy runbook

Four steps. Nothing here needs Claude — each step is copy-pasteable.

Project ref: `axdikbsghdotugnotzof`

---

## Step 0 — decide the equity-curve question first

`portfolio_snapshots` grew from 50 rows to ~2,985 without this repo doing
anything, so another process is writing to it. The scanner also writes there
with `paper = true`. If that other writer also writes paper rows, the two
systems interleave and neither equity curve means anything afterwards.

Check before deploying:

```sql
select paper, count(*), min(ts), max(ts) from portfolio_snapshots group by paper;
```

- **Other writer only touches `paper = false`** → nothing to do, continue.
- **Other writer also writes `paper = true`** → give the scanner its own table
  (see "Isolating the equity curve" at the bottom) before Step 3.

---

## Step 1 — schema

Supabase Dashboard → SQL Editor → paste the contents of
`supabase/migrations/20260821_arb_scanner.sql` → Run.

Creates `scan_runs`, `market_snapshots`, `paper_positions`, and enables RLS on
all three. RLS with no policies revokes anon access entirely; the function uses
the service role key, which bypasses RLS, so collection is unaffected.

Verify:

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public'
  and tablename in ('scan_runs','market_snapshots','paper_positions');
```

Expect three rows, `rowsecurity = true` on each.

---

## Step 2 — deploy the function

Requires the Supabase CLI locally (it is not available in the Claude container):

```bash
git clone https://github.com/kapamikey/kalshi-arb && cd kalshi-arb
supabase link --project-ref axdikbsghdotugnotzof
supabase functions deploy scan
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — do
not set them yourself. Leave JWT verification ON (the default).

Optional tuning, via Dashboard → Edge Functions → scan → Secrets:

| Var | Default | Effect |
|---|---|---|
| `MIN_NET_EDGE_CENTS` | `1` | Minimum locked profit to open a basket |
| `CONTRACTS` | `20` | Basket size |

---

## Step 3 — first run, before scheduling anything

Run it once by hand and read the result. Do not enable the cron until this
returns `ok: true`.

```bash
curl -s -X POST \
  'https://axdikbsghdotugnotzof.supabase.co/functions/v1/scan' \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

Then:

```sql
select ts, ok, events, markets, opportunities, positions_opened, error
from scan_runs order by ts desc limit 3;
```

**Expected on a healthy first run:** `ok = true`, `events` and `markets` in the
hundreds or thousands, `opportunities` almost certainly **0**.

Zero opportunities is the expected result, not a failure. Genuine cross-outcome
arbs on a liquid book close in seconds; a poll will rarely catch one. The value
being produced here is the quote history in `market_snapshots`.

**If `ok = false`,** read `scan_runs.error`. The most likely cause is a Kalshi
API field-name mismatch — the client was written without live API access, since
`api.elections.kalshi.com` is blocked from the Claude container. Unverified
assumptions, in rough order of risk:

1. `/markets?tickers=A,B,C` accepts a comma-separated list
2. Settled markets expose `result` as `"yes"` / `"no"`
3. `/events` returns `mutually_exclusive` on the event object
4. `with_nested_markets=true` nests markets under each event

Paste the error back and it's a quick fix.

---

## Step 4 — schedule

Only after Step 3 returns `ok: true`.

Create the Vault secret (once, with the real key — it never goes in the job
body, which is readable by anyone with database access):

```sql
select vault.create_secret('<SERVICE_ROLE_KEY>', 'kalshi_arb_service_key');
```

Then paste `supabase/migrations/20260821_schedule.sql` into the SQL Editor.

Verify and monitor:

```sql
select jobname, schedule, active from cron.job;

-- Is it alive? Gaps here are the alert.
select ts, ok, markets, opportunities, positions_opened, error
from scan_runs order by ts desc limit 20;
```

To stop:

```sql
select cron.unschedule('kalshi-arb-scan');
select cron.unschedule('kalshi-arb-prune-snapshots');
```

---

## Isolating the equity curve

Only if Step 0 showed a collision:

```sql
create table if not exists public.paper_equity (
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  account_value numeric not null
);
alter table public.paper_equity enable row level security;
```

Then in `supabase/functions/scan/index.ts`, `writeEquityPoint`: change
`.from("portfolio_snapshots")` to `.from("paper_equity")` and drop the
`paper: true` field from the inserted object. Redeploy.

---

## Storage

`market_snapshots` gains one row per open market per run — order of 10^5–10^6
rows/day across all of Kalshi at a 5-minute cadence. The prune job in
`20260821_schedule.sql` keeps 30 days. Shorten that interval if storage bites,
or narrow collection to sports by filtering `series_ticker` in `snapshotRows`.
