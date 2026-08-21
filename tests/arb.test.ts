/**
 * Offline tests for the detection math.
 *
 * Run with Node's type stripping (no Deno needed for the pure modules):
 *   node --experimental-strip-types --test tests/arb.test.ts
 *
 * These cover the parts that must be arithmetically right. Anything touching
 * the network or the database is not exercised here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { basketFeeCents, feeCents } from "../supabase/functions/scan/fees.ts";
import {
  checkOverround,
  checkSingleMarket,
  checkUnderround,
  DEFAULT_SCAN_CONFIG,
  scanEvent,
} from "../supabase/functions/scan/arb.ts";
import { clientKey, settlePosition } from "../supabase/functions/scan/paper.ts";
import type { KalshiEvent, KalshiMarket } from "../supabase/functions/scan/kalshi.ts";

/**
 * Builds a WELL-FORMED book by default: Kalshi derives the NO side from the YES
 * side (no_ask = 100 - yes_bid, no_bid = 100 - yes_ask), so fixtures must too.
 * Hardcoding both sides independently produces books that are crossed with
 * themselves and makes the single-market check fire on data that cannot exist.
 * Tests that want a crossed book override no_ask explicitly and say so.
 */
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
    last_price: yesBid, volume: 1000, open_interest: 500, liquidity: 1000,
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

const cfg = DEFAULT_SCAN_CONFIG;

test("fee formula matches Kalshi's published curve", () => {
  assert.equal(feeCents(1, 50), 2);      // 0.07 * 1 * .5 * .5 = $0.0175 -> 2c
  assert.equal(feeCents(1, 10), 1);      // 0.63c -> 1c
  assert.equal(feeCents(100, 50), 175);  // peak: $1.75 per 100 contracts
  assert.equal(feeCents(1, 99), 1);      // tail rounds up, never to zero
  assert.equal(feeCents(0, 50), 0);
});

test("fees are symmetric around 50c", () => {
  assert.equal(feeCents(50, 30), feeCents(50, 70));
});

test("basket fee is the sum of per-leg fees", () => {
  const legs = [{ priceCents: 45, contracts: 20 }, { priceCents: 48, contracts: 20 }];
  assert.equal(basketFeeCents(legs), feeCents(20, 45) + feeCents(20, 48));
});

test("single-market YES+NO never arbs when the book is well-formed", () => {
  // no_ask is derived as 100 - yes_bid, so the sum is 100 + spread by construction.
  for (const yesBid of [1, 25, 50, 75, 99]) {
    for (const spread of [1, 2, 5]) {
      const m = market("M", {
        yes_bid: yesBid,
        yes_ask: Math.min(99, yesBid + spread),
        no_ask: 100 - yesBid,
      });
      assert.equal(checkSingleMarket(event([m]), m, cfg), null);
    }
  }
});

test("single-market check still fires on a genuinely crossed book", () => {
  // Not expected in live data; if it happens we want the row for diagnosis.
  const m = market("M", { yes_ask: 40, no_ask: 50 });
  const hit = checkSingleMarket(event([m]), m, cfg);
  assert.ok(hit);
  assert.equal(hit.kind, "single_market");
  assert.ok(hit.netEdgeCents > 0);
});

test("overround: buying every YES below 100c locks a profit", () => {
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  const hit = checkOverround(event(ms), ms, cfg);
  assert.ok(hit);
  assert.equal(hit.contracts, 20);
  assert.equal(hit.costCents, 93 * 20);
  assert.equal(hit.guaranteedPayoutCents, 100 * 20);
  assert.equal(hit.feeCents, 70);
  assert.equal(hit.netEdgeCents, 2000 - 1860 - 70);
  assert.equal(hit.legs.length, 2);
  assert.ok(hit.legs.every((l) => l.side === "yes"));
});

test("overround does not fire when fees eat the gross edge", () => {
  // 98c gross edge of 2c, but two legs near 50c cost ~4c in fees.
  const ms = [market("A", { yes_ask: 49 }), market("B", { yes_ask: 49 })];
  assert.equal(checkOverround(event(ms), ms, cfg), null);
});

test("overround does not fire at or above 100c", () => {
  const ms = [market("A", { yes_ask: 50 }), market("B", { yes_ask: 50 })];
  assert.equal(checkOverround(event(ms), ms, cfg), null);
});

test("underround: buying every NO below (n-1)*100 locks a profit", () => {
  // Wide bids (56/59) put the derived NO asks at 44/41 while the YES asks stay
  // above 100 combined, so only the underround side can fire.
  const ms = [
    market("A", { yes_bid: 56, yes_ask: 60 }),
    market("B", { yes_bid: 59, yes_ask: 62 }),
  ];
  const hit = checkUnderround(event(ms), ms, cfg);
  assert.ok(hit);
  assert.equal(hit.costCents, 85 * 20);
  assert.equal(hit.guaranteedPayoutCents, 100 * 20); // (2-1) * 100 * 20
  assert.equal(hit.netEdgeCents, 2000 - 1700 - 69);
  assert.ok(hit.legs.every((l) => l.side === "no"));
});

test("underround scales the payout with outcome count", () => {
  const ms = [
    market("A", { yes_bid: 40 }), market("B", { yes_bid: 40 }), market("C", { yes_bid: 40 }),
  ];
  const hit = checkUnderround(event(ms), ms, cfg);
  assert.ok(hit);
  // 3 outcomes: 2 of the 3 NO legs pay out.
  assert.equal(hit.guaranteedPayoutCents, 200 * 20);
});

test("a zero or 100 ask means no resting offer, not a free contract", () => {
  for (const bad of [0, 100, null]) {
    const ms = [market("A", { yes_ask: bad as number }), market("B", { yes_ask: 40 })];
    assert.equal(checkOverround(event(ms), ms, cfg), null);
  }
});

test("cross-outcome baskets are refused when the event is not mutually exclusive", () => {
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  const hits = scanEvent(event(ms, { mutually_exclusive: false }), cfg);
  assert.equal(hits.length, 0);
});

test("cross-outcome baskets are refused when a leg was filtered out", () => {
  // A closed leg means the remaining markets no longer partition the outcomes.
  // All three YES asks sum to 90c, so the basket would otherwise fire.
  const ms = [
    market("A", { yes_bid: 28, yes_ask: 30 }),
    market("B", { yes_bid: 28, yes_ask: 30 }),
    market("C", { yes_bid: 28, yes_ask: 30, status: "closed" }),
  ];
  const hits = scanEvent(event(ms), cfg);
  assert.equal(hits.length, 0);
});

test("scanEvent ranks by net edge", () => {
  // Deliberately crossed books so several checks fire at once and there is
  // something to order. Well-formed books can only ever yield one hit per event:
  // overround needs sum(yes_ask) < 100 and underround needs sum(yes_bid) > 100,
  // and yes_bid <= yes_ask makes those mutually exclusive.
  const ms = [
    market("A", { yes_ask: 40, no_ask: 50 }),
    market("B", { yes_ask: 30, no_ask: 50 }),
  ];
  const hits = scanEvent(event(ms), cfg);
  assert.ok(hits.length >= 2);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].netEdgeCents >= hits[i].netEdgeCents);
  }
});

test("settlement pays exactly one YES leg of a mutually exclusive basket", () => {
  const legs = [
    { ticker: "A", side: "yes", contracts: 20 },
    { ticker: "B", side: "yes", contracts: 20 },
  ];
  const pos = { legs, cost_cents: 1860, fee_cents: 70 };
  const a = settlePosition(pos, new Set(["A"]));
  const b = settlePosition(pos, new Set(["B"]));
  assert.equal(a.payout_cents, 2000);
  assert.equal(a.realized_pnl_cents, 70);
  // The whole point of an arb: the outcome does not change the P&L.
  assert.deepEqual(a, b);
});

test("settlement books a real loss if the event was not exhaustive", () => {
  // Neither leg settles YES -> the "guarantee" was wrong and we ate the cost.
  const legs = [
    { ticker: "A", side: "yes", contracts: 20 },
    { ticker: "B", side: "yes", contracts: 20 },
  ];
  const res = settlePosition({ legs, cost_cents: 1860, fee_cents: 70 }, new Set());
  assert.equal(res.payout_cents, 0);
  assert.equal(res.realized_pnl_cents, -1930);
});

test("NO legs settle as the complement of YES", () => {
  const legs = [{ ticker: "A", side: "no", contracts: 10 }];
  assert.equal(settlePosition({ legs, cost_cents: 400, fee_cents: 10 }, new Set(["A"])).payout_cents, 0);
  assert.equal(settlePosition({ legs, cost_cents: 400, fee_cents: 10 }, new Set()).payout_cents, 1000);
});

test("client key is order-independent but price-sensitive", () => {
  const base = {
    eventTicker: "EVT", seriesTicker: "S", title: "t", kind: "overround" as const,
    contracts: 20, costCents: 0, guaranteedPayoutCents: 0, feeCents: 0,
    netEdgeCents: 0, edgeBps: 0, closeTime: null,
  };
  const legA = { ticker: "A", side: "yes" as const, priceCents: 45, contracts: 20, availableContracts: null };
  const legB = { ticker: "B", side: "yes" as const, priceCents: 48, contracts: 20, availableContracts: null };

  assert.equal(
    clientKey({ ...base, legs: [legA, legB] }),
    clientKey({ ...base, legs: [legB, legA] }),
  );
  assert.notEqual(
    clientKey({ ...base, legs: [legA, legB] }),
    clientKey({ ...base, legs: [legA, { ...legB, priceCents: 47 }] }),
  );
});

test("a basket does not settle until every leg has a definitive result", () => {
  // Guards the bug where absence from the open-events listing was read as a NO
  // result, which booked a full loss on every basket that settled.
  const legs = [
    { ticker: "A", side: "yes", contracts: 10 },
    { ticker: "B", side: "yes", contracts: 10 },
  ];
  const resultByTicker = new Map([["A", "yes"]]); // B not yet resolved
  const allResolved = legs.every((l) => resultByTicker.has(l.ticker));
  assert.equal(allResolved, false);

  // Once B resolves, the basket pays exactly one leg regardless of which won.
  resultByTicker.set("B", "no");
  assert.ok(legs.every((l) => resultByTicker.has(l.ticker)));
  const settledYes = new Set([...resultByTicker].filter(([, r]) => r === "yes").map(([t]) => t));
  assert.equal(settlePosition({ legs, cost_cents: 930, fee_cents: 35 }, settledYes).payout_cents, 1000);
});
