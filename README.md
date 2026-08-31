# kalshi-arb

Read-only Kalshi arbitrage scanner with a paper-trading ledger, running as a
scheduled Supabase Edge Function.

**No credentials, no signing, no order placement.** Every Kalshi call is public
market data over GET. There is no code path that can touch a real account.

## What it does

Every 5 minutes:

1. Pulls all open Kalshi events with their nested markets.
2. Snapshots every market book into `market_snapshots` — the data-collection
   job, which runs whether or not any edge exists.
3. Runs arb detection per event.
4. Opens a paper position for each basket clearing the edge threshold.
5. Settles positions whose markets have resolved.
6. Appends an equity point to `portfolio_snapshots` (`paper = true`).

## The detection logic

Within a single market, "buy YES and buy NO" is **never** an arbitrage. Kalshi
derives the NO book from the YES book (`no_ask = 100 - yes_bid`), so

```
yes_ask + no_ask  =  yes_ask + 100 - yes_bid  =  100 + spread  >=  100
```

always. You pay the spread; you never collect it. There is no code for that case
because it cannot fire — only a test asserting the invariant.

The real opportunity is **across the outcomes of one mutually-exclusive event**,
where separate books are quoted by different participants:

| Kind | Condition | Why it's locked |
|---|---|---|
| `overround` | `sum(yes_ask) < 100 - fees` | Exactly one outcome pays 100¢ |
| `underround` | `sum(no_ask) < (n-1)*100 - fees` | Exactly `n-1` NO legs pay 100¢ |

Both require the event to be mutually exclusive *and* collectively exhaustive.
Baskets are refused on unflagged events and on any event where a leg was
filtered out, since a missing outcome breaks the guarantee.

Fees use Kalshi's `ceil(0.07 * C * P * (1-P))` curve in integer basis points —
the float form rounds `feeCents(100, 50)` to 176 instead of 175, and a one-cent
error is the same size as the edges being measured.

### Honest limits

- **A 5-minute poll will rarely catch a real arb.** Genuine cross-outcome
  mispricings on a liquid book close in seconds. What this reliably produces is
  the quote history — which is what actually answers "does exploitable spread
  exist, and at what size". Capture needs a streaming feed, not a cron.
- **Fill risk is not modelled.** A scanner can't observe whether both legs would
  fill before the book moves. Locked P&L is an **upper bound**.
- **Depth is unknown.** Kalshi's markets endpoint returns no level sizes, so
  basket size is a config constant, not a book-derived number.
- Every leg assumes **crossing the spread**. Assuming mid fills is the main way
  paper arb books flatter themselves.
- Settlement reconciles against *observed* results, so a broken assumption shows
  up as a real loss rather than silently booking expected profit.

## Layout

```
supabase/functions/scan/index.ts   Scheduled entrypoint
supabase/functions/scan/arb.ts     Fee curve + basket detection
supabase/functions/scan/kalshi.ts  Read-only market data client
supabase/functions/scan/paper.ts   Ledger identity + settlement
supabase/migrations/               Schema + cron schedule
tests/arb.test.ts                  Offline tests for the math
web/                               Read-only dashboard (Vite + React)
```

`supabase/functions/<name>/` is required by the Supabase CLI.

## Tests

Pure math runs under Node's type stripping — no Deno needed:

```bash
node --experimental-strip-types --test tests/arb.test.ts
```

## Deploy

```bash
supabase link --project-ref axdikbsghdotugnotzof
supabase db push
supabase functions deploy scan
```

Then set the Vault secret and enable the schedule per
`supabase/migrations/20260821_schedule.sql`.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
Optional tuning: `MIN_NET_EDGE_CENTS` (default 1), `CONTRACTS` (default 20).

## Dashboard

A clickable, read-only viewer over scan_runs, paper_positions, and market_snapshots.

It never inserts scanner rows, never talks to Kalshi, and does not ship a service-role token to the browser.

Live: https://kapamikey.github.io/kalshi-arb/

Local server is documented in web/README.md.
Local: cd web && bun install && bun dev  (http://localhost:5173).

Env: copy web/.env.example. VITE_SUPABASE_URL defaults to the linked project. VITE_SUPABASE_ANON_KEY is the anon/publishable token only.
If the build omits it, paste on the page (stored in localStorage only).

Apply supabase/migrations/20260830_dashboard_read.sql and
supabase/migrations/20260831_paper_portfolio_read.sql (`supabase db push`, or
the Supabase SQL editor) so anon SELECT policies exist. The second file is
paper=true rows of portfolio_snapshots only; whale history stays hidden.
Publish `web/dist` to the `gh-pages` branch. Rebuild: `cd web && VITE_BASE=/kalshi-arb/ bun run build`.

## Reading the results

```sql
-- Is it alive?
select ts, ok, events, markets, opportunities, positions_opened, error
from scan_runs order by ts desc limit 20;

-- Paper book
select status, count(*), sum(cost_cents), sum(locked_pnl_cents), sum(realized_pnl_cents)
from paper_positions group by status;

-- Sports only — a query-time filter, not a collection-time one
select * from market_snapshots where series_ticker like 'KXNFL%' order by ts desc;
```

An empty `paper_positions` with healthy `scan_runs` is a **real result**, not a
bug: no exploitable cross-outcome mispricing existed at the scanned cadence.
`market_snapshots` accumulates regardless, so the question stays answerable.

## Note on the pre-existing tables

`trades` and `portfolio_snapshots` come from an earlier directional strategy
(signal type `whale`) not in this repo. They are untouched. That strategy's
recorded history is 7 closed trades, all stop-losses, −$14.32 — all `dry_run`,
so simulated rather than realised.
