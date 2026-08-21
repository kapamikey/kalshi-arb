# kalshi-arb

Read-only Kalshi arbitrage scanner with a paper-trading ledger, running as a
scheduled Supabase Edge Function.

**No credentials, no signing, no order placement.** Every Kalshi call in this
repo is public market data over GET. There is no code path that can touch a real
account; adding one would be a deliberate, separate change.

## What it does

Every 5 minutes:

1. Pulls all open Kalshi events with their nested markets.
2. Writes a book snapshot per sports market to `market_snapshots` — this is the
   data-collection job, and it runs whether or not any edge exists.
3. Runs arbitrage detection per event.
4. Opens a paper position for each basket clearing the edge threshold.
5. Settles paper positions whose markets have resolved.
6. Appends an equity point to `portfolio_snapshots` (`paper = true`).

## The detection logic, and an important caveat

Within a single market, "buy YES and buy NO" is **never** an arbitrage. Kalshi
derives the NO book from the YES book (`no_ask = 100 - yes_bid`), so

```
yes_ask + no_ask  =  yes_ask + 100 - yes_bid  =  100 + spread  >=  100
```

always. You pay the spread; you never collect it. A scanner that only looks for
`yes_ask + no_ask < 100` finds nothing, forever. This repo still computes it, as
an invariant check — a hit means we misread the book, not that we found money.

The real opportunity is **across the outcomes of one mutually-exclusive event**,
where separate order books are quoted by different participants:

| Kind | Condition | Why it's locked |
|---|---|---|
| `overround` | `sum(yes_ask) < 100 - fees` | Exactly one outcome pays 100¢ |
| `underround` | `sum(no_ask) < (n-1)*100 - fees` | Exactly `n-1` NO legs pay 100¢ |

Both require the event to be mutually exclusive *and* collectively exhaustive.
Kalshi flags this per event; baskets are refused on unflagged events and on any
event where a leg was filtered out, because a missing outcome (an unlisted draw,
a suspended market) breaks the guarantee.

Fees use Kalshi's published curve, `ceil(0.07 * C * P * (1-P))`, computed in
integer basis points — the float form rounds `feeCents(100, 50)` up to 176
instead of 175, and a one-cent error is the same order of magnitude as the edges
being measured.

### Honest limits

- **Fill risk is not modelled.** A scanner cannot observe whether both legs
  would actually fill before the book moves. Locked P&L is an **upper bound**.
- **Depth is unknown.** The markets endpoint doesn't return level sizes, so
  basket size is capped by config, not by the book. Positions carry
  `depth_verified = false`.
- Every leg is assumed to **cross the spread** (pay the ask). Assuming mid fills
  is the main way paper arb books flatter themselves.
- Settlement reconciles against *observed* results, not the theoretical
  guarantee, so a broken assumption shows up as a real loss rather than silently
  booking its expected profit.

## Layout

```
supabase/functions/scan/index.ts   Scheduled entrypoint
supabase/functions/scan/arb.ts     Detection: overround / underround
supabase/functions/scan/fees.ts    Kalshi fee curve (integer cents)
supabase/functions/scan/kalshi.ts  Read-only market data client
supabase/functions/scan/paper.ts   Paper ledger + settlement
supabase/migrations/               Schema + cron schedule
tests/arb.test.ts                  Offline tests for the math
```

The `supabase/functions/<name>/` nesting is required by the Supabase CLI and is
as flat as this can get while staying deployable.

## Tests

The pure math modules run under Node's type stripping — no Deno needed:

```bash
node --experimental-strip-types --test tests/arb.test.ts
```

18 tests cover the fee curve, the single-market invariant, overround/underround
detection and rejection, exhaustiveness guards, and settlement arithmetic.
Nothing touching the network or database is exercised.

## Deploy

```bash
supabase link --project-ref axdikbsghdotugnotzof
supabase db push                              # applies migrations
supabase functions deploy scan
```

Then set the Vault secret and enable the schedule as documented in
`supabase/migrations/20260821_schedule.sql`.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into Edge Functions
automatically. Optional tuning env vars: `MIN_NET_EDGE_CENTS` (default 1),
`MAX_CONTRACTS` (default 20), `MIN_VOLUME` (default 0).

## Reading the results

```sql
select * from paper_performance;

select ts, ok, sports_events, markets_scanned, opportunities, positions_opened, error
from scan_runs order by ts desc limit 20;

select ts, title, kind, cost_cents, net_edge_cents, edge_bps
from arb_opportunities order by net_edge_cents desc limit 20;
```

An empty `arb_opportunities` with healthy `scan_runs` is a real result, not a
bug: it means no exploitable cross-outcome mispricing existed at the scanned
cadence. `market_snapshots` accumulates regardless, so the question stays
answerable later.

## Note on the pre-existing tables

`trades` and `portfolio_snapshots` come from an earlier directional strategy
(signal type `whale`) that is not in this repo. They are left untouched. That
strategy's recorded history is 7 closed trades, all stop-losses, −$14.32 — worth
knowing before reusing any of its parameters.
