/**
 * Offline tests for the detection math.
 *
 *   node --experimental-strip-types --test tests/arb.test.ts
 *
 * Covers the parts that must be arithmetically right. Nothing touching the
 * network or the database is exercised here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  checkBasket,
  DEFAULT_SCAN_CONFIG,
  feeCents,
  scanEvent,
} from "../supabase/functions/scan/arb.ts";
import { clientKey, settlePosition } from "../supabase/functions/scan/paper.ts";
import {
  asCents,
  asCount,
  centsFromDollars,
  normalizeMarket,
  type KalshiEvent,
  type KalshiMarket,
} from "../supabase/functions/scan/kalshi.ts";

/**
 * Builds a WELL-FORMED book by default: Kalshi derives the NO side from the YES
 * side (no_ask = 100 - yes_bid, no_bid = 100 - yes_ask), so fixtures must too.
 * Hardcoding both sides independently produces books crossed with themselves.
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

test("YES basket below 100c locks a profit", () => {
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  const hit = checkBasket(event(ms), ms, "yes", cfg);
  assert.ok(hit);
  assert.equal(hit.kind, "overround");
  assert.equal(hit.contracts, 20);
  assert.equal(hit.costCents, 93 * 20);
  assert.equal(hit.guaranteedPayoutCents, 100 * 20);
  assert.equal(hit.feeCents, 70);
  assert.equal(hit.netEdgeCents, 2000 - 1860 - 70);
  assert.ok(hit.legs.every((l) => l.side === "yes"));
});

test("YES basket does not fire when fees eat the gross edge", () => {
  // 98c is a 2c gross edge, but two legs near 50c cost ~4c in fees.
  const ms = [market("A", { yes_ask: 49 }), market("B", { yes_ask: 49 })];
  assert.equal(checkBasket(event(ms), ms, "yes", cfg), null);
});

test("YES basket does not fire at or above 100c", () => {
  const ms = [market("A", { yes_ask: 50 }), market("B", { yes_ask: 50 })];
  assert.equal(checkBasket(event(ms), ms, "yes", cfg), null);
});

test("NO basket below (n-1)*100 locks a profit", () => {
  // Wide bids (56/59) put the derived NO asks at 44/41 while the YES asks stay
  // above 100 combined, so only the NO side can fire.
  const ms = [
    market("A", { yes_bid: 56, yes_ask: 60 }),
    market("B", { yes_bid: 59, yes_ask: 62 }),
  ];
  const hit = checkBasket(event(ms), ms, "no", cfg);
  assert.ok(hit);
  assert.equal(hit.kind, "underround");
  assert.equal(hit.costCents, 85 * 20);
  assert.equal(hit.guaranteedPayoutCents, 100 * 20); // (2-1) * 100 * 20
  assert.equal(hit.netEdgeCents, 2000 - 1700 - 69);
  assert.ok(hit.legs.every((l) => l.side === "no"));
});

test("NO basket payout scales with outcome count", () => {
  const ms = ["A", "B", "C"].map((t) => market(t, { yes_bid: 40 }));
  const hit = checkBasket(event(ms), ms, "no", cfg);
  assert.ok(hit);
  // 3 outcomes: 2 of the 3 NO legs pay out.
  assert.equal(hit.guaranteedPayoutCents, 200 * 20);
});

test("a zero or 100 ask means no resting offer, not a free contract", () => {
  for (const bad of [0, 100, null]) {
    const ms = [market("A", { yes_ask: bad as number }), market("B", { yes_ask: 40 })];
    assert.equal(checkBasket(event(ms), ms, "yes", cfg), null);
  }
});

test("well-formed books can never produce a single-market arb", () => {
  // no_ask = 100 - yes_bid, so yes_ask + no_ask = 100 + spread >= 100 always.
  // This is why no single-market check exists.
  for (const yesBid of [1, 25, 50, 75, 99]) {
    for (const spread of [1, 2, 5]) {
      const m = market("M", { yes_bid: yesBid, yes_ask: Math.min(99, yesBid + spread) });
      assert.ok((m.yes_ask ?? 0) + (m.no_ask ?? 0) >= 100);
    }
  }
});

test("baskets are refused when the event is not mutually exclusive", () => {
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  assert.equal(scanEvent(event(ms, { mutually_exclusive: false }), cfg).length, 0);
});

test("baskets are refused when a leg was filtered out", () => {
  // A closed leg means the remaining markets no longer partition the outcomes.
  // All three YES asks sum to 90c, so the basket would otherwise fire.
  const ms = [
    market("A", { yes_bid: 28, yes_ask: 30 }),
    market("B", { yes_bid: 28, yes_ask: 30 }),
    market("C", { yes_bid: 28, yes_ask: 30, status: "closed" }),
  ];
  assert.equal(scanEvent(event(ms), cfg).length, 0);
});

test("scanEvent finds at most one direction on a well-formed book", () => {
  // YES needs sum(yes_ask) < 100; NO needs sum(yes_bid) > 100. Since
  // yes_bid <= yes_ask, both can never hold at once.
  const ms = [market("A", { yes_ask: 45 }), market("B", { yes_ask: 48 })];
  const hits = scanEvent(event(ms), cfg);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "overround");
});

test("scanEvent ranks by net edge", () => {
  const ms = [market("A", { yes_bid: 56, yes_ask: 57 }), market("B", { yes_bid: 59, yes_ask: 60 })];
  const hits = scanEvent(event(ms), cfg);
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
  const pos = { legs, cost_cents: 400, fee_cents: 10 };
  assert.equal(settlePosition(pos, new Set(["A"])).payout_cents, 0);
  assert.equal(settlePosition(pos, new Set()).payout_cents, 1000);
});

test("a basket does not settle until every leg has a definitive result", () => {
  // Guards the bug where absence from the open-events listing was read as a NO
  // result, which booked a full loss on every basket that settled.
  const legs = [
    { ticker: "A", side: "yes", contracts: 10 },
    { ticker: "B", side: "yes", contracts: 10 },
  ];
  const results = new Map([["A", "yes"]]); // B not yet resolved
  assert.equal(legs.every((l) => results.has(l.ticker)), false);

  results.set("B", "no");
  assert.ok(legs.every((l) => results.has(l.ticker)));
  const settledYes = new Set([...results].filter(([, r]) => r === "yes").map(([t]) => t));
  assert.equal(settlePosition({ legs, cost_cents: 930, fee_cents: 35 }, settledYes).payout_cents, 1000);
});

test("client key is order-independent but price-sensitive", () => {
  const base = {
    eventTicker: "EVT", seriesTicker: "S", title: "t", kind: "overround" as const,
    contracts: 20, costCents: 0, guaranteedPayoutCents: 0, feeCents: 0,
    netEdgeCents: 0, closeTime: null,
  };
  const legA = { ticker: "A", side: "yes" as const, priceCents: 45, contracts: 20 };
  const legB = { ticker: "B", side: "yes" as const, priceCents: 48, contracts: 20 };

  assert.equal(
    clientKey({ ...base, legs: [legA, legB] }),
    clientKey({ ...base, legs: [legB, legA] }),
  );
  assert.notEqual(
    clientKey({ ...base, legs: [legA, legB] }),
    clientKey({ ...base, legs: [legA, { ...legB, priceCents: 47 }] }),
  );
});

test("centsFromDollars maps Kalshi dollar strings to integer cents", () => {
  assert.equal(centsFromDollars("0.4500"), 45);
  assert.equal(centsFromDollars("0.45"), 45);
  assert.equal(centsFromDollars("0.0000"), 0);
  assert.equal(centsFromDollars("1.0000"), 100);
  assert.equal(centsFromDollars("0.1230"), 12); // deci-cent rounds to nearest cent
  assert.equal(centsFromDollars(null), null);
  assert.equal(centsFromDollars(""), null);
  assert.equal(centsFromDollars("nope"), null);
});

test("asCents prefers legacy integer cents over dollar strings", () => {
  assert.equal(asCents(45, "0.9900"), 45);
  assert.equal(asCents(0, "0.4500"), 0);
  assert.equal(asCents(undefined, "0.4500"), 45);
  assert.equal(asCents(null, "0.1200"), 12);
});

test("asCount rounds volume_fp strings", () => {
  assert.equal(asCount(1000, "9.00"), 1000);
  assert.equal(asCount(undefined, "118109.87"), 118110);
  assert.equal(asCount(undefined, "0.00"), 0);
  assert.equal(asCount(undefined, null), null);
});

test("normalizeMarket fills integer-cent fields from *_dollars", () => {
  const n = normalizeMarket({
    ticker: "A",
    event_ticker: "EVT",
    status: "active",
    yes_bid: null,
    yes_ask: null,
    no_bid: null,
    no_ask: null,
    last_price: null,
    volume: null,
    open_interest: null,
    liquidity: null,
    close_time: null,
    yes_bid_dollars: "0.4500",
    yes_ask_dollars: "0.4800",
    no_bid_dollars: "0.5200",
    no_ask_dollars: "0.5500",
    last_price_dollars: "0.4600",
    volume_fp: "260.00",
    open_interest_fp: "10.00",
    liquidity_dollars: "1.2500",
  });
  assert.equal(n.yes_bid, 45);
  assert.equal(n.yes_ask, 48);
  assert.equal(n.no_bid, 52);
  assert.equal(n.no_ask, 55);
  assert.equal(n.last_price, 46);
  assert.equal(n.volume, 260);
  assert.equal(n.open_interest, 10);
  assert.equal(n.liquidity, 125);
});

test("dollar-string books are scannable after normalizeMarket", () => {
  const raw = [
    market("A", {
      yes_bid: null, yes_ask: null, no_bid: null, no_ask: null,
      yes_bid_dollars: "0.4300",
      yes_ask_dollars: "0.4500",
      no_bid_dollars: "0.5500",
      no_ask_dollars: "0.5700",
    }),
    market("B", {
      yes_bid: null, yes_ask: null, no_bid: null, no_ask: null,
      yes_bid_dollars: "0.4600",
      yes_ask_dollars: "0.4800",
      no_bid_dollars: "0.5200",
      no_ask_dollars: "0.5400",
    }),
  ];
  assert.equal(scanEvent(event(raw), cfg).length, 0, "un-normalized dollar books must not fire");
  const ms = raw.map(normalizeMarket);
  const hits = scanEvent(event(ms), cfg);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "overround");
  assert.equal(hits[0].costCents, 93 * 20);
});

test("un-normalized dollar floats are not treated as sub-cent asks", () => {
  // 0.45 dollars would pass a naive 0<ask<100 check and then corrupt fee math.
  const ms = [market("A", { yes_ask: 0.45 }), market("B", { yes_ask: 0.48 })];
  assert.equal(checkBasket(event(ms), ms, "yes", cfg), null);
});
