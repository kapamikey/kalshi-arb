# kalshi-arb

Kalshi arbitrage scanner (5-minute **public** quotes) plus a **demo paper trader**
that can place signed orders against Kalshi's demo / testing-cash API.

The public scanner still has **no credentials, no signing, no order placement**.
Demo trading is **off by default** (`KALSHI_TRADING_ENABLED=false`) and hard-crashes
on boot if a production Trade API host is configured.

Viewer: https://kapamikey.github.io/kalshi-arb/

## Friday 9/4 cut vs next week

**This week (must ship Friday 2026-09-04)**

- Kill-switch demo REST client. Allowlist only:
  `https://external-api.demo.kalshi.co/trade-api/v2`
  (alias `https://demo-api.kalshi.co/trade-api/v2`).
- RSA-PSS SHA256 signer (`timestamp + METHOD + path`, no query string).
- `demo_orders` table + anon SELECT. 1 contract per leg.
- `trade` Edge Function on a **30-second** cron against ~20 open mutually-exclusive
  **demo** events. Detect and execute on demo books. `POST /portfolio/events/orders`
  with `client_order_id` idempotency and `fill_or_kill` (no GTC).
- Thin `DEMO PAPER` strip on the existing `web/` dashboard.
- Testing cash only. No live money.

**Not this week**

- WebSocket `orderbook_delta` / always-on Fly worker
- Scanning every demo event
- Human vs Nerd restyle, extra tables/charts
- Size 20 on the demo trader (demo + paper writers are 1 lot/leg)
- `demo_fills` / `demo_baskets`
- Live / production keys. Live money is a later spec, not a flag flip.

## Demo secrets and flags

Never commit PEM files, keys, or `.env`. Never put Kalshi secrets in `web/` or
GitHub Pages. Pages only gets the Supabase **anon** key.

Set these as **Edge Function secrets** (Vault), not in the repo:

| Secret | Default | Notes |
|---|---|---|
| `KALSHI_TRADING_ENABLED` | `false` | Must be `true` to place demo orders. |
| `KALSHI_API_BASE` | `https://external-api.demo.kalshi.co/trade-api/v2` | Allowlisted demo hosts only. Production hosts (`external-api.kalshi.com`, `api.elections.kalshi.com`) **crash on boot before any HTTP**. |
| `KALSHI_DEMO_KEY_ID` | empty | Demo API Key ID from [demo.kalshi.co](https://demo.kalshi.co/). |
| `KALSHI_DEMO_PRIVATE_KEY_PEM` | empty | Demo RSA private key PEM. `\n` escapes and base64-of-PEM are accepted. |
| `DEMO_EVENT_CAP` | `200` | Max mutually-exclusive open demo events per run. |
| `MIN_NET_EDGE_CENTS` | `1` | Reused from `arb.ts`. Fee / overround math is not forked. |

Empty keys:

- **Trading disabled** — function starts, writes `Trader OFF`, places **zero** orders, no Kalshi HTTP.
- **Trading enabled** — boot fails clearly until the demo key is in Vault.

```bash
supabase secrets set KALSHI_TRADING_ENABLED=false
supabase secrets set KALSHI_API_BASE=https://external-api.demo.kalshi.co/trade-api/v2
# After Michael puts the demo key in Vault (due Tue 9/1):
#   supabase secrets set KALSHI_DEMO_KEY_ID=<demo-key-id>
#   supabase secrets set KALSHI_DEMO_PRIVATE_KEY_PEM="$(cat /path/to/demo.pem)"
#   supabase secrets set KALSHI_TRADING_ENABLED=true
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 30-second cron

The public scanner stays on its 5-minute job (`kalshi-arb-scan`). The trader is a
**separate** function and schedule.

1. Deploy the function: `supabase functions deploy trade`
2. Apply schema + schedule: `supabase db push`
   (`supabase/migrations/20260831_demo_orders.sql` and
   `20260831_trade_schedule.sql`).
3. Confirm: `select jobname, schedule from cron.job;`
   should include `kalshi-arb-trade` at `30 seconds`, timeout 50s (< 55s cap).

The schedule uses the existing Vault secret `kalshi_arb_service_key` (same
pattern as the scanner). If you need to turn the cron off:

```sql
select cron.unschedule('kalshi-arb-trade');
```

Re-enable:

```sql
select cron.schedule(
  'kalshi-arb-trade',
  '30 seconds',
  $$
  select net.http_post(
    url := 'https://axdikbsghdotugnotzof.supabase.co/functions/v1/trade',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'kalshi_arb_service_key'
      )
    ),
    timeout_milliseconds := 50000
  );
  $$
);
```

Leave `KALSHI_TRADING_ENABLED=false` until the demo key is in Vault. The cron
can run in that state; it will not call Kalshi.

## What the 5-minute scanner does

Every 5 minutes (unchanged):

1. Pulls all open Kalshi events with their nested markets (public GET, production market data).
2. Snapshots every market book into `market_snapshots`.
3. Runs arb detection per event.
4. Opens a **local** paper position for each basket clearing the edge threshold.
5. Settles positions whose markets have resolved.
6. Appends an equity point to `portfolio_snapshots` (`paper = true`).

That scanner never authenticates to Kalshi. It is quote history + a simulated
ledger. The demo trader is a different path: it reads **demo** books and posts
**demo** orders.

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

The demo trader **reuses** `arb.ts`. It does not fork fee or overround math.
It only overrides size to **1 contract per leg**.

### Honest limits

- **A 5-minute poll will rarely catch a real arb.** Genuine cross-outcome
  mispricings on a liquid book close in seconds. What this reliably produces is
  the quote history. Capture needs a streaming feed, not a cron — that's next
  week if Friday holds.
- **Demo books ≠ live.** Fills on demo do not prove production edges.
- **Fill risk is not modelled** on the scanner ledger. Locked P&L is an **upper bound**.
- **Depth is unknown** on the public markets endpoint.
- Every scanner paper fill assumes **crossing the spread**.
- Demo orders use `fill_or_kill` at the ask. If a later leg rejects, earlier
  filled legs are left as-is this week (no cancel-rest orchestration).

## Layout

```
supabase/functions/scan/index.ts   5-min public scanner (no Kalshi credentials)
supabase/functions/scan/arb.ts     Fee curve + basket detection (shared)
supabase/functions/scan/kalshi.ts  Read-only production market data
supabase/functions/scan/paper.ts   Local paper ledger identity + settlement
supabase/functions/trade/index.ts  30s demo trader
supabase/functions/trade/client.ts Demo allowlist + RSA-PSS signer
supabase/migrations/               Schema + cron schedules
tests/arb.test.ts                  Offline tests for the math
tests/demo-client.test.ts          Production-host crash + signer
web/                               Dashboard (Vite + React) + DEMO PAPER strip
```

`supabase/functions/<name>/` is required by the Supabase CLI.

## Tests

```bash
bun test tests/arb.test.ts
bun test tests/demo-client.test.ts
```

Pure math also runs under Node's type stripping:

```bash
bun test tests/arb.test.ts tests/demo-client.test.ts
```

## Deploy

```bash
supabase link --project-ref axdikbsghdotugnotzof
supabase db push
supabase functions deploy scan
supabase functions deploy trade
```

Then set Vault secrets (above) and confirm both cron jobs.

Optional scanner tuning: `MIN_NET_EDGE_CENTS` (default 1), `CONTRACTS` (default 20)
applies to the **scanner paper book only**. The demo trader is hard-capped at 1
contract per leg this week.


## Dashboard

A clickable viewer over scan_runs, paper_positions, market_snapshots, and
`demo_orders`.

It never inserts scanner rows, never talks to Kalshi from the browser, and does
not ship a service-role token or a Kalshi PEM to Pages.

Live: https://kapamikey.github.io/kalshi-arb/

The first thing on the page is a `DEMO PAPER` strip: trader status sentence,
last 3 demo orders, and `Demo books ≠ live. 5-min scanner is still history.`
Existing health / paper book / snapshots stay below.

Local: `cd web && bun install && bun dev` (http://localhost:5173).

Env: copy `web/.env.example`. `VITE_SUPABASE_URL` defaults to the linked project.
`VITE_SUPABASE_ANON_KEY` is the anon/publishable token only.
If the build omits it, paste on the page (stored in localStorage only).

Apply `supabase/migrations/20260830_dashboard_read.sql`,
`20260831_demo_orders.sql`, and `20260831_paper_equity_read.sql`
(`supabase db push`) so anon SELECT policies exist (demo blotter and paper
`portfolio_snapshots` included).
Publish `web/dist` to the `gh-pages` branch. Rebuild:
`cd web && VITE_BASE=/kalshi-arb/ bun run build`.

## Reading the results

```sql
-- Is the scanner alive?
select ts, ok, events, markets, opportunities, positions_opened, error
from scan_runs order by ts desc limit 20;

-- Demo blotter
select ts, status, ticker, side, event_ticker, kind, kalshi_order_id, reject_reason
from demo_orders
where basket_id <> '__trader__'
order by ts desc
limit 20;

-- Trader sentence
select status, event_ticker, kind, reject_reason, ts
from demo_orders
where client_order_id = 'trader-status';

-- Paper book (scanner, not demo fills)
select status, count(*), sum(cost_cents), sum(locked_pnl_cents), sum(realized_pnl_cents)
from paper_positions group by status;
```

An empty `paper_positions` with healthy `scan_runs` is a **real result**, not a
bug: no exploitable cross-outcome mispricing existed at the scanned cadence.
`market_snapshots` accumulates regardless, so the question stays answerable.

## Note on the pre-existing tables

`trades` and `portfolio_snapshots` come from an earlier directional strategy
(signal type `whale`) not in this repo. They are untouched. That strategy's
recorded history is 7 closed trades, all stop-losses, −$14.32 — all `dry_run`,
so simulated rather than realised.
