/**
 * Ticket-desk honesty tests. No network, no secrets.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { checkBasket, DEFAULT_SCAN_CONFIG, feeCents } from "../supabase/functions/scan/arb.ts";
import {
  displayedAsksFromOrderbook,
  dollarsToCents,
} from "../supabase/functions/scan/kalshi.ts";
import {
  CRON_POSTS_ORDERS,
  approveBlockedReason,
  isQuoteExpired,
  scoreEventTickets,
  seriesAllowed,
  shouldWriteOpenTicket,
  type TicketDraft,
} from "../supabase/functions/trade/tickets.ts";
import {
  assertDemoTradeBase,
  createKalshiDemoClient,
  readTradeEnv,
} from "../supabase/functions/trade/client.ts";
import type { DisplayedAsks, KalshiEvent, KalshiMarket } from "../supabase/functions/scan/kalshi.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

function book(yesAsk: number, yesSize: number, noAsk: number, noSize: number): DisplayedAsks {
  return {
    yes_ask: yesAsk,
    yes_ask_size: yesSize,
    no_ask: noAsk,
    no_ask_size: noSize,
    depthKnown: true,
  };
}

test("arb fee curve is unchanged (49¢ peak still 2¢ on 1 lot)", () => {
  assert.equal(feeCents(1, 49), 2);
  assert.equal(feeCents(1, 50), 2);
});

test("49+49 is not a ticket after taker fees", () => {
  const ms = [market("A", { yes_ask: 49 }), market("B", { yes_ask: 49 })];
  const cfg = { ...DEFAULT_SCAN_CONFIG, contracts: 1 };
  assert.equal(checkBasket(event(ms), ms, "yes", cfg), null);

  const books = new Map<string, DisplayedAsks>([
    ["A", book(49, 10, 51, 10)],
    ["B", book(49, 10, 51, 10)],
  ]);
  assert.equal(scoreEventTickets(event(ms), books, 0.07, "2026-09-01T00:00:00Z").length, 0);
});

test("size=2 conservative is ask+1¢ and disagrees with optimistic", () => {
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  const books = new Map<string, DisplayedAsks>([
    ["A", book(45, 2, 55, 2)],
    ["B", book(48, 2, 52, 2)],
  ]);
  const drafts = scoreEventTickets(event(ms), books, 0.07, "2026-09-01T00:00:00Z");
  assert.equal(drafts.length, 1);
  const d = drafts[0];
  const opt = checkBasket(event(ms), ms, "yes", { ...DEFAULT_SCAN_CONFIG, contracts: 1 });
  const walked = [
    market("A", { yes_ask: 46 }),
    market("B", { yes_ask: 49 }),
  ];
  const cons = checkBasket(event(walked), walked, "yes", { ...DEFAULT_SCAN_CONFIG, contracts: 1 });
  assert.ok(opt && cons);
  assert.equal(d.optimistic_pnl_cents, opt.netEdgeCents);
  assert.equal(d.conservative_pnl_cents, cons.netEdgeCents);
  assert.notEqual(d.optimistic_pnl_cents, d.conservative_pnl_cents);
  assert.ok(d.conservative_pnl_cents! > 0);
  assert.ok(shouldWriteOpenTicket(d));
});

test("size=1 conservative is unfilled and writes no open ticket", () => {
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  const books = new Map<string, DisplayedAsks>([
    ["A", book(45, 1, 55, 10)],
    ["B", book(48, 10, 52, 10)],
  ]);
  const drafts = scoreEventTickets(event(ms), books, 0.07, "2026-09-01T00:00:00Z");
  assert.equal(drafts.length, 0);
});

test("missing orderbook depth writes no open ticket", () => {
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  const books = new Map<string, DisplayedAsks>([
    ["A", book(45, 10, 55, 10)],
  ]);
  assert.equal(scoreEventTickets(event(ms), books, 0.07, "2026-09-01T00:00:00Z").length, 0);
});

test("quotes older than 30s expire; 30s exactly is still live", () => {
  const quoted = "2026-09-01T00:00:00.000Z";
  const t0 = Date.parse(quoted);
  assert.equal(isQuoteExpired(quoted, t0 + 30_000), false);
  assert.equal(isQuoteExpired(quoted, t0 + 30_001), true);
  assert.equal(
    approveBlockedReason(
      {
        quoted_ts: quoted,
        depth_known: true,
        min_displayed_size: 2,
        conservative_pnl_cents: 3,
        optimistic_pnl_cents: 5,
        net_edge_cents: 5,
        status: "open",
      },
      t0 + 31_000,
    ),
    "stale",
  );
});

test("flat fee series and perps are skipped", () => {
  assert.equal(seriesAllowed({ fee_type: "flat", fee_multiplier: 1 }, "KXSOMETHING").ok, false);
  assert.equal(seriesAllowed({ fee_type: "quadratic", fee_multiplier: 1 }, "KXBTCPERP").ok, false);
  assert.equal(seriesAllowed({ fee_type: "quadratic", fee_multiplier: 1 }, "KXNFLGAME").ok, true);
});

test("executable asks come from the orderbook, not a size-less /markets quote", () => {
  const asks = displayedAsksFromOrderbook({
    yes_dollars: [["0.4000", "2.00"]],
    no_dollars: [["0.5500", "3.00"]],
  });
  assert.equal(asks.yes_ask, 45);
  assert.equal(asks.yes_ask_size, 3);
  assert.equal(asks.no_ask, 60);
  assert.equal(asks.no_ask_size, 2);
  assert.equal(asks.depthKnown, true);
  assert.equal(dollarsToCents("0.3200"), 32);
});

test("Friday trade cron source never POSTs orders", () => {
  assert.equal(CRON_POSTS_ORDERS, false);
  const src = readFileSync(join(root, "supabase/functions/trade/index.ts"), "utf8");
  assert.doesNotMatch(src, /createEventOrder/);
  assert.doesNotMatch(src, /placeBasket/);
  assert.doesNotMatch(src, /portfolio\/events\/orders/);
  assert.match(src, /posted: false/);
  assert.match(src, /refreshTickets/);
});

test("production Trade API hosts still throw before HTTP", () => {
  const fetches: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    fetches.push(String(input));
    throw new Error("HTTP should not run");
  };
  assert.throws(
    () => assertDemoTradeBase("https://api.elections.kalshi.com/trade-api/v2"),
    /production Trade API host|not a demo Trade API host/,
  );
  assert.throws(
    () =>
      createKalshiDemoClient({
        apiBase: "https://external-api.kalshi.com/trade-api/v2",
        apiKeyId: "key-id",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nM\n-----END PRIVATE KEY-----",
        fetch: fakeFetch,
      }),
    /production Trade API host|not a demo Trade API host/,
  );
  assert.throws(
    () =>
      readTradeEnv((k) =>
        ({ KALSHI_API_BASE: "https://api.elections.kalshi.com/trade-api/v2" }[k]),
      ),
    /production Trade API host|not a demo Trade API host/,
  );
  assert.equal(fetches.length, 0);
});

test("approveBlockedReason covers dishonest tickets", () => {
  const base = {
    quoted_ts: new Date().toISOString(),
    depth_known: true,
    min_displayed_size: 2,
    conservative_pnl_cents: 3,
    optimistic_pnl_cents: 5,
    net_edge_cents: 5,
    status: "open",
  };
  assert.equal(approveBlockedReason(base), null);
  assert.equal(approveBlockedReason({ ...base, depth_known: false, min_displayed_size: null }), "no depth");
  assert.equal(approveBlockedReason({ ...base, min_displayed_size: 1 }), "size < 2");
  assert.equal(approveBlockedReason({ ...base, conservative_pnl_cents: 0 }), "conservative ≤ 0");
  assert.equal(approveBlockedReason({ ...base, optimistic_pnl_cents: 0, net_edge_cents: 0 }), "optimistic net ≤ 0");
});

test("shouldWriteOpenTicket requires optimistic, conservative, depth, size>=2", () => {
  const d: TicketDraft = {
    event_ticker: "EVT",
    title: "t",
    kind: "overround",
    legs: [
      { ticker: "A", side: "yes", ask_cents: 45, displayed_size: 2 },
      { ticker: "B", side: "yes", ask_cents: 48, displayed_size: 2 },
    ],
    quoted_ts: new Date().toISOString(),
    fee_cents: 4,
    net_edge_cents: 5,
    optimistic_pnl_cents: 5,
    conservative_pnl_cents: 1,
    min_displayed_size: 2,
    depth_known: true,
  };
  assert.equal(shouldWriteOpenTicket(d), true);
  assert.equal(shouldWriteOpenTicket({ ...d, conservative_pnl_cents: null }), false);
  assert.equal(shouldWriteOpenTicket({ ...d, min_displayed_size: 1 }), false);
  assert.equal(shouldWriteOpenTicket({ ...d, depth_known: false }), false);
  assert.equal(shouldWriteOpenTicket({ ...d, optimistic_pnl_cents: 0, net_edge_cents: 0 }), false);
});
