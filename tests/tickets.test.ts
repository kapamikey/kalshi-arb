/**
 * Ticket-desk scoring, 30s expiry, and cron-must-not-POST.
 *
 *   bun test tests/arb.test.ts tests/demo-client.test.ts tests/tickets.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkBasket, DEFAULT_SCAN_CONFIG, feeCents } from "../supabase/functions/scan/arb.ts";
import {
  displayedAsksFromOrderbook,
  type DisplayedAsks,
  type KalshiEvent,
  type KalshiMarket,
} from "../supabase/functions/scan/kalshi.ts";
import {
  CRON_POSTS_ORDERS,
  TICKET_TTL_MS,
  approveBlockedReason,
  isQuoteExpired,
  scoreEventTickets,
  shouldWriteOpenTicket,
  type TicketDraft,
} from "../supabase/functions/trade/tickets.ts";
import {
  assertDemoTradeBase,
  createKalshiDemoClient,
  readTradeEnv,
} from "../supabase/functions/trade/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

function market(ticker: string, over: Partial<KalshiMarket> = {}): KalshiMarket {
  const yesBid = over.yes_bid ?? 40;
  const yesAsk = over.yes_ask ?? yesBid + 2;
  return {
    ticker,
    event_ticker: "EVT",
    status: "active",
    yes_bid: yesBid,
    yes_ask: yesAsk,
    no_bid: 100 - yesAsk,
    no_ask: 100 - yesBid,
    last_price: yesBid,
    volume: 1000,
    open_interest: 500,
    liquidity: 1000,
    close_time: "2026-08-22T23:00:00Z",
    ...over,
  };
}

function event(markets: KalshiMarket[], over: Partial<KalshiEvent> = {}): KalshiEvent {
  return {
    event_ticker: "EVT",
    series_ticker: "KXNFLGAME",
    title: "Team A vs Team B",
    mutually_exclusive: true,
    markets,
    ...over,
  };
}

function book(yesAsk: number, yesSize: number, noAsk = 60, noSize = 10): DisplayedAsks {
  return {
    yes_ask: yesAsk,
    yes_ask_size: yesSize,
    no_ask: noAsk,
    no_ask_size: noSize,
    depthKnown: true,
  };
}

const quoted = "2026-09-01T12:00:00.000Z";

test("arb math still matches Kalshi's published curve", () => {
  assert.equal(feeCents(1, 50), 2);
  assert.equal(feeCents(100, 50), 175);
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  const hit = checkBasket(event(ms), ms, "yes", DEFAULT_SCAN_CONFIG);
  assert.ok(hit);
  assert.equal(hit.netEdgeCents, 2000 - 1860 - 70);
});

test("production Trade API hosts throw BEFORE any HTTP", () => {
  const fetches: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    fetches.push(String(input));
    throw new Error("HTTP should not run");
  };
  for (const base of [
    "https://external-api.kalshi.com/trade-api/v2",
    "https://api.elections.kalshi.com/trade-api/v2",
  ]) {
    assert.throws(() => assertDemoTradeBase(base), /production Trade API host|not a demo Trade API host/);
    assert.throws(
      () =>
        createKalshiDemoClient({
          apiBase: base,
          apiKeyId: "key-id",
          privateKeyPem: "-----BEGIN PRIVATE KEY-----\nM\n-----END PRIVATE KEY-----",
          fetch: fakeFetch,
        }),
      /production Trade API host|not a demo Trade API host/,
    );
    assert.throws(
      () => readTradeEnv((k) => (k === "KALSHI_API_BASE" ? base : undefined)),
      /production Trade API host|not a demo Trade API host/,
    );
  }
  assert.equal(fetches.length, 0);
});

test("size=2 conservative is 1 lot at ask+1¢, not the optimistic touch", () => {
  const ev = event([market("A"), market("B")]);
  const books = new Map<string, DisplayedAsks>([
    ["A", book(45, 2)],
    ["B", book(48, 2)],
  ]);
  const drafts = scoreEventTickets(ev, books, 0.07, quoted);
  assert.equal(drafts.length, 1);
  const d = drafts[0];
  assert.equal(d.kind, "overround");
  assert.equal(d.min_displayed_size, 2);
  assert.ok(d.optimistic_pnl_cents > 0);
  assert.ok(d.conservative_pnl_cents != null && d.conservative_pnl_cents > 0);
  assert.notEqual(d.optimistic_pnl_cents, d.conservative_pnl_cents);
  assert.ok(d.optimistic_pnl_cents > d.conservative_pnl_cents!);

  const walked = [
    market("A", { yes_ask: 46 }),
    market("B", { yes_ask: 49 }),
  ];
  const cons = checkBasket(event(walked), walked, "yes", {
    feeRate: 0.07,
    minNetEdgeCents: 1,
    contracts: 1,
  });
  assert.ok(cons);
  assert.equal(d.conservative_pnl_cents, cons.netEdgeCents);
});

test("displayed size 1 does not write an open ticket (conservative unfilled)", () => {
  const ev = event([market("A"), market("B")]);
  const books = new Map<string, DisplayedAsks>([
    ["A", book(45, 1)],
    ["B", book(48, 2)],
  ]);
  const drafts = scoreEventTickets(ev, books, 0.07, quoted);
  assert.equal(drafts.length, 0);
});

test("cron never POSTs: tripwire is false and trade/index has no order client", () => {
  assert.equal(CRON_POSTS_ORDERS, false);
  const tradeSrc = readFileSync(join(repo, "supabase/functions/trade/index.ts"), "utf8");
  assert.match(tradeSrc, /NEVER places orders/);
  assert.doesNotMatch(tradeSrc, /createEventOrder|createKalshiDemoClient/);
  assert.match(tradeSrc, /posted: false/);
  const ticketsSrc = readFileSync(join(repo, "supabase/functions/trade/tickets.ts"), "utf8");
  assert.match(ticketsSrc, /CRON_POSTS_ORDERS = false/);
});

test("49+49 two-leg is not a ticket (fees eat the gross)", () => {
  const ev = event([market("A"), market("B")]);
  const books = new Map<string, DisplayedAsks>([
    ["A", book(49, 10)],
    ["B", book(49, 10)],
  ]);
  const drafts = scoreEventTickets(ev, books, 0.07, quoted);
  assert.equal(drafts.length, 0);
  const ms = [market("A", { yes_ask: 49 }), market("B", { yes_ask: 49 })];
  assert.equal(
    checkBasket(event(ms), ms, "yes", { feeRate: 0.07, minNetEdgeCents: 1, contracts: 1 }),
    null,
  );
});

test("quotes older than 30s are expired; Approve is blocked", () => {
  const now = Date.parse("2026-09-01T12:00:31.000Z");
  assert.equal(TICKET_TTL_MS, 30_000);
  assert.equal(isQuoteExpired("2026-09-01T12:00:00.000Z", now), true);
  assert.equal(isQuoteExpired("2026-09-01T12:00:01.000Z", now), false);
  assert.equal(
    approveBlockedReason(
      {
        quoted_ts: "2026-09-01T12:00:00.000Z",
        legs: [
          { ticker: "A", side: "yes", ask_cents: 45, displayed_size: 2 },
          { ticker: "B", side: "yes", ask_cents: 48, displayed_size: 2 },
        ],
        conservative_pnl_cents: 1,
        optimistic_pnl_cents: 3,
        net_edge_cents: 3,
        status: "open",
      },
      now,
    ),
    "stale",
  );
});

test("missing orderbook depth is not an open ticket", () => {
  const ev = event([market("A"), market("B")]);
  const books = new Map<string, DisplayedAsks>([["A", book(45, 5)]]);
  assert.equal(scoreEventTickets(ev, books, 0.07, quoted).length, 0);
});

test("orderbook size comes from displayed bid depth, not /markets top", () => {
  const asks = displayedAsksFromOrderbook({
    yes: [[40, 7]],
    no: [[55, 3]],
  });
  // Buy YES lifts complement of best NO bid 55 → yes_ask 45, size 3.
  assert.equal(asks.yes_ask, 45);
  assert.equal(asks.yes_ask_size, 3);
  assert.equal(asks.no_ask, 60);
  assert.equal(asks.no_ask_size, 7);
  assert.equal(asks.depthKnown, true);
});

test("shouldWriteOpenTicket refuses conservative ≤ 0 or unknown depth", () => {
  const base: TicketDraft = {
    event_ticker: "EVT",
    title: "t",
    kind: "overround",
    legs: [],
    quoted_ts: quoted,
    fee_cents: 4,
    net_edge_cents: 3,
    optimistic_pnl_cents: 3,
    conservative_pnl_cents: 1,
    min_displayed_size: 2,
    depth_known: true,
  };
  assert.equal(shouldWriteOpenTicket(base), true);
  assert.equal(shouldWriteOpenTicket({ ...base, conservative_pnl_cents: 0 }), false);
  assert.equal(shouldWriteOpenTicket({ ...base, conservative_pnl_cents: null }), false);
  assert.equal(shouldWriteOpenTicket({ ...base, depth_known: false }), false);
  assert.equal(shouldWriteOpenTicket({ ...base, min_displayed_size: 1 }), false);
});
