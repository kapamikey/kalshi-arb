# kalshi-arb

Read-only Kalshi arbitrage scanner (5-minute public quotes) plus a **demo paper trader**.

**No live money.** Production Trade API hosts are a boot crash, not a warning.

The 5-minute scanner still has **no credentials, no signing, no order placement**. Demo orders live in a separate always-on `trader/` worker, never in the browser and never in the `scan` Edge Function.

Viewer: https://kapamikey.github.io/kalshi-arb/

## What it does

Every 5 minutes the public scanner:

1. Pulls all open Kalshi events with their nested markets.
2. Snapshots every market book into `market_snapshots`.
3. Runs arb detection per event.
4. Opens a **simulated** paper position for each basket clearing the edge threshold.
5. Settles positions whose markets have resolved.
6. Appends an equity point to `portfolio_snapshots` (`paper = true`).

Separately, the demo trader (off by default) watches **demo** books over WebSocket and, when enabled, signs IOC/FOK orders against Kalshi demo only. Fills go into `demo_baskets` / `demo_orders` / `demo_fills` — not `paper_positions`.

## The detection logic

Within a single market, "buy YES and buy NO" is **never** an arbitrage. Kalshi derives the NO book from the YES book (`no_ask = 100 - yes_bid`), so you pay the spread. The real opportunity is **across the outcomes of one mutually-exclusive event**:

| Kind | Condition | Why it's locked |
|---|---|---|
| `overround` | `sum(yes_ask) < 100 - fees` | Exactly one outcome pays 100¢ |
| `underround` | `sum(no_ask) < (n-1)*100 - fees` | Exactly `n-1` NO legs pay 100¢ |

Fees use Kalshi's `ceil(0.07 * C * P * (1-P))` curve in integer basis points. Do not change the fee curve / overround vs underround math; the trader reuses `arb.ts`.

## Demo paper trader

Always-on worker in `trader/`. Pick Fly (`trader/fly.toml`) or run locally with bun.

### Hosts (allowlist — crash otherwise)

- REST: `https://external-api.demo.kalshi.co/trade-api/v2` (alias `https://demo-api.kalshi.co/trade-api/v2`)
- WS: `wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2`
- Docs: [Demo env](https://docs.kalshi.com/getting_started/demo_env), [Environments](https://docs.kalshi.com/getting_started/api_environments), [API keys](https://docs.kalshi.com/getting_started/api_keys), [Create order](https://docs.kalshi.com/getting_started/quick_start_create_order), [WebSockets](https://docs.kalshi.com/getting_started/quick_start_websockets)

Any production host (`external-api.kalshi.com`, `api.elections.kalshi.com`, `*.kalshi.com` trade API) is a **hard crash on boot**.

### Flags and secrets

Never commit PEM files, keys, or `.env`. Never put Kalshi secrets in `web/` or GitHub Pages.

| Env | Default | Notes |
|---|---|---|
| `KALSHI_ENV` | (required `demo`) | Anything else refuses to start. |
| `KALSHI_REST_BASE` | demo external-api | Allowlisted demo hosts only. |
| `KALSHI_WS_URL` | demo external-api-ws | Allowlisted demo WS only. |
| `KALSHI_TRADING_ENABLED` | `false` | Off by default. False → process can start, **places zero orders**. |
| `KALSHI_API_KEY_ID` | empty | Demo Key ID from [demo.kalshi.co](https://demo.kalshi.co/) (not the live login). |
| `KALSHI_PRIVATE_KEY` | empty | Demo RSA PEM. Boot-fails only when trading is enabled. |
| `DEMO_ORDER_CONTRACTS` | `1` | First demo orders are **1 contract per leg**. |
| `CONTRACTS` | `20` | Cap. `DEMO_ORDER_CONTRACTS` is clamped to this. Scanner paper book still uses 20. |
| `KALSHI_TIME_IN_FORCE` | `fill_or_kill` | `immediate_or_cancel` also allowed. **GTC is a boot crash.** |
| `MIN_NET_EDGE_CENTS` | `1` | Same threshold as the scanner. |
| `MAX_SUBSCRIPTIONS` | `40` | Market cap on the WS universe. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | empty | Required when trading is enabled (ledger writes). |

**Live money is a later spec**, not a flag flip.

### Run locally

```bash
cp trader/.env.example trader/.env
# edit trader/.env — KALSHI_ENV=demo, trading false until you have a demo key
bun install
bun run trader
# health: http://127.0.0.1:8080/
```

Without a demo API key: leave `KALSHI_TRADING_ENABLED=false`. The process starts, writes `Trader is OFF.`, places zero orders.

With a demo key (Vault / `trader/.env`, never chat):

```bash
# Account: https://demo.kalshi.co/  (credentials are not the live Kalshi login)
# Create a demo API key: https://docs.kalshi.com/getting_started/api_keys
KALSHI_TRADING_ENABLED=true
KALSHI_API_KEY_ID=...
KALSHI_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

Then `supabase db push` so `20260831_demo_trader.sql` exists, and the Human view can read fills.

### Fly

```bash
fly launch --config trader/fly.toml --no-deploy
fly secrets set KALSHI_ENV=demo KALSHI_TRADING_ENABLED=false \
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
# later: fly secrets set KALSHI_API_KEY_ID=... KALSHI_PRIVATE_KEY=... KALSHI_TRADING_ENABLED=true
fly deploy --config trader/fly.toml
```

`KALSHI_TRADING_ENABLED` stays false on the host until you flip the secret. Health JSON never includes keys.

## Layout

```
supabase/functions/scan/index.ts   Scheduled public scanner (no Kalshi credentials)
supabase/functions/scan/arb.ts     Fee curve + basket detection
supabase/functions/scan/kalshi.ts  Read-only production market data (scanner only)
supabase/functions/scan/paper.ts   Simulated ledger identity + settlement
supabase/migrations/               Schema + cron + dashboard RLS + demo trader RLS
tests/arb.test.ts                  Offline tests for the math
tests/trader.test.ts               Kill-switch / boot / zero-order tests
trader/                            Always-on demo paper trader (Fly / bun)
web/                               GitHub Pages dashboard (Human default, Nerd toggle)
```

## Tests

```bash
bun test tests/arb.test.ts
bun test tests/trader.test.ts
# or: bun test tests/
```

## Dashboard

Default page is **Human view**: DEMO PAPER badge, one status sentence, Demo P&L, last 5 events, read-only trader ON/OFF. No "Place live order" button. Nerd view at the bottom restores the scanner tables.

It never inserts scanner rows, never talks to Kalshi, and does not ship a service-role token or PEM to the browser.

Local: `cd web && bun install && bun dev` (http://localhost:5173). Env: copy `web/.env.example`. `VITE_SUPABASE_ANON_KEY` is the anon token only.

Apply `supabase/migrations/20260830_dashboard_read.sql` and `20260831_demo_trader.sql` (`supabase db push`).

## Note on the pre-existing tables

`trades` and `portfolio_snapshots` come from an earlier directional strategy (signal type `whale`) not in this repo. They are untouched. `paper_positions` is the **simulated** 5-minute scanner book, not Kalshi demo fills.
