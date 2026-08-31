import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify, constants as cryptoConstants } from "node:crypto";
import { assertDemoRestBase, assertDemoWsUrl, DEFAULT_DEMO_REST, DEFAULT_DEMO_WS, isProductionTradeHost, ProductionHostError, signingPath } from "../trader/hosts.ts";
import { loadTraderConfig, TraderBootError } from "../trader/env.ts";
import { DemoKalshiClient } from "../trader/client.ts";
import { signedHeaders, loadPrivateKey, wsHandshakeHeaders } from "../trader/sign.ts";
import { executeBasket, v2OrderBody, clientOrderId } from "../trader/orders.ts";
import { applyDelta, applySnapshot, emptyBook, topOfBook } from "../trader/books.ts";
import { selectUniverse } from "../trader/loop.ts";
import type { ArbOpportunity } from "../supabase/functions/scan/arb.ts";
import type { KalshiEvent, KalshiMarket } from "../supabase/functions/scan/kalshi.ts";

const PROD_REST = ["https://external-api.kalshi.com/trade-api/v2", "https://api.elections.kalshi.com/trade-api/v2", "https://api.kalshi.com/trade-api/v2", "https://trading-api.kalshi.com/trade-api/v2"];
const PROD_WS = ["wss://external-api-ws.kalshi.com/trade-api/ws/v2", "wss://api.elections.kalshi.com/trade-api/ws/v2"];
const demoEnv = { KALSHI_ENV: "demo", KALSHI_REST_BASE: DEFAULT_DEMO_REST, KALSHI_WS_URL: DEFAULT_DEMO_WS, KALSHI_TRADING_ENABLED: "false" };
function opp(): ArbOpportunity {
  return { eventTicker: "KXTEST", seriesTicker: "KXTEST", title: "Test", kind: "overround",
    legs: [{ ticker: "A", side: "yes", priceCents: 40, contracts: 1 }, { ticker: "B", side: "yes", priceCents: 45, contracts: 1 }],
    contracts: 1, costCents: 85, guaranteedPayoutCents: 100, feeCents: 2, netEdgeCents: 13, closeTime: null };
}
function mkt(ticker: string): KalshiMarket {
  return { ticker, event_ticker: "E", status: "active", yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60, last_price: 40, volume: 0, open_interest: 0, liquidity: 0, close_time: null };
}

test("production REST hosts are flagged", () => {
  for (const u of PROD_REST) assert.equal(isProductionTradeHost(u), true);
  assert.equal(isProductionTradeHost(DEFAULT_DEMO_REST), false);
  assert.equal(isProductionTradeHost("https://demo-api.kalshi.co/trade-api/v2"), false);
});
test("assertDemoRestBase throws on production before any HTTP", () => {
  for (const u of PROD_REST) assert.throws(() => assertDemoRestBase(u), ProductionHostError);
  assert.equal(assertDemoRestBase(DEFAULT_DEMO_REST), DEFAULT_DEMO_REST);
});
test("assertDemoWsUrl throws on production WS", () => {
  for (const u of PROD_WS) assert.throws(() => assertDemoWsUrl(u), ProductionHostError);
  assert.equal(assertDemoWsUrl(DEFAULT_DEMO_WS), DEFAULT_DEMO_WS);
});
test("order client constructor throws on production URL; fetch is never called", () => {
  let called = 0;
  const fetchFn = async () => { called++; return new Response("nope"); };
  for (const u of PROD_REST) {
    assert.throws(() => new DemoKalshiClient({ restBase: u, fetch: fetchFn, apiKeyId: "x", privateKeyPem: "y" }), ProductionHostError);
  }
  assert.equal(called, 0);
});
test("demo client request refuses a production hostname even if somehow resolved", async () => {
  let called = 0;
  const client = new DemoKalshiClient({ restBase: DEFAULT_DEMO_REST, fetch: async (url) => { called++; return new Response(`should not hit ${url}`); } });
  await assert.rejects(() => client.request("POST", "https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders"), ProductionHostError);
  assert.equal(called, 0);
});
test("trader refuses to start if KALSHI_ENV is not demo", () => {
  assert.throws(() => loadTraderConfig({ ...demoEnv, KALSHI_ENV: "production" }), TraderBootError);
  assert.throws(() => loadTraderConfig({ ...demoEnv, KALSHI_ENV: "" }), TraderBootError);
});
test("trader refuses to start if a configured host is production", () => {
  assert.throws(() => loadTraderConfig({ ...demoEnv, KALSHI_REST_BASE: PROD_REST[0] }), ProductionHostError);
  assert.throws(() => loadTraderConfig({ ...demoEnv, KALSHI_WS_URL: PROD_WS[0] }), ProductionHostError);
});
test("trader starts with trading off and empty keys", () => {
  const cfg = loadTraderConfig(demoEnv);
  assert.equal(cfg.tradingEnabled, false); assert.equal(cfg.env, "demo");
  assert.equal(cfg.orderContracts, 1); assert.equal(cfg.contractsCap, 20); assert.equal(cfg.timeInForce, "fill_or_kill");
});
test("trading enabled with empty keys is a boot fail", () => {
  assert.throws(() => loadTraderConfig({ ...demoEnv, KALSHI_TRADING_ENABLED: "true" }), TraderBootError);
});
test("GTC is a boot crash", () => {
  assert.throws(() => loadTraderConfig({ ...demoEnv, KALSHI_TIME_IN_FORCE: "good_till_canceled" }), TraderBootError);
});
test("DEMO_ORDER_CONTRACTS is clamped by CONTRACTS cap", () => {
  assert.equal(loadTraderConfig({ ...demoEnv, CONTRACTS: "20", DEMO_ORDER_CONTRACTS: "99" }).orderContracts, 20);
});
test("KALSHI_TRADING_ENABLED false places zero orders", async () => {
  let posts = 0;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const client = new DemoKalshiClient({ restBase: DEFAULT_DEMO_REST, apiKeyId: "test-key", privateKeyPem: pem,
    fetch: async (url, init) => { posts++; throw new Error(`unexpected fetch ${init?.method} ${url}`); } });
  const result = await executeBasket({ client, timeInForce: "fill_or_kill", tradingEnabled: false }, "key", opp());
  assert.equal(result.outcome, "skipped"); assert.equal(result.ordersPlaced, 0); assert.equal(posts, 0);
});
test("signing payload is timestamp+method+path with no query", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const key = loadPrivateKey(pem);
  const headers = signedHeaders({ keyId: "kid", key, method: "POST", path: "/trade-api/v2/portfolio/events/orders?foo=1", timestampMs: 1_700_000_000_000 });
  assert.equal(headers["KALSHI-ACCESS-KEY"], "kid");
  assert.equal(headers["KALSHI-ACCESS-TIMESTAMP"], "1700000000000");
  const v = createVerify("RSA-SHA256");
  v.update("1700000000000POST/trade-api/v2/portfolio/events/orders");
  v.end();
  assert.equal(v.verify({ key: publicKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64")), true);
});
test("WS handshake signs GET /trade-api/ws/v2", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const key = loadPrivateKey(pem);
  const headers = wsHandshakeHeaders({ keyId: "kid", key, timestampMs: 42 });
  const v = createVerify("RSA-SHA256");
  v.update("42GET/trade-api/ws/v2");
  v.end();
  assert.equal(v.verify({ key: publicKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(headers["KALSHI-ACCESS-SIGNATURE"], "base64")), true);
});
test("signingPath strips query strings", () => {
  assert.equal(signingPath("https://external-api.demo.kalshi.co/trade-api/v2/portfolio/orders?limit=5"), "/trade-api/v2/portfolio/orders");
});
test("V2 order body buys YES as bid and NO as ask (yes-leg price)", () => {
  const yes = v2OrderBody({ ticker: "A", side: "yes", priceCents: 40, contracts: 1 }, { clientOrderId: "c", timeInForce: "fill_or_kill" });
  assert.equal(yes.side, "bid"); assert.equal(yes.price, "0.4000");
  const no = v2OrderBody({ ticker: "B", side: "no", priceCents: 40, contracts: 1 }, { clientOrderId: "c", timeInForce: "immediate_or_cancel" });
  assert.equal(no.side, "ask"); assert.equal(no.price, "0.6000");
});
test("client_order_id is stable for a basket leg", () => {
  assert.equal(clientOrderId("k", "A", "yes"), clientOrderId("k", "A", "yes"));
  assert.notEqual(clientOrderId("k", "A", "yes"), clientOrderId("k", "B", "yes"));
});
test("orderbook snapshot derives asks the Kalshi way", () => {
  const book = emptyBook("M");
  applySnapshot(book, { yes_dollars_fp: [["0.0800", "10.00"], ["0.2200", "5.00"]], no_dollars_fp: [["0.5400", "2.00"], ["0.5600", "8.00"]] }, 1);
  const top = topOfBook(book);
  assert.equal(top.yes_bid, 22); assert.equal(top.no_bid, 56); assert.equal(top.yes_ask, 44); assert.equal(top.no_ask, 78);
});
test("orderbook sequence gap marks the book stale", () => {
  const book = emptyBook("M");
  applySnapshot(book, { yes_dollars_fp: [["0.40", "1"]], no_dollars_fp: [["0.50", "1"]] }, 5);
  assert.equal(applyDelta(book, { price_dollars: "0.41", delta_fp: "1.00", side: "yes" }, 7), false);
  assert.equal(book.stale, true);
});
test("universe selection caps markets and keeps mutually exclusive events", () => {
  const events: KalshiEvent[] = [
    { event_ticker: "BIG", mutually_exclusive: true, markets: [mkt("a"), mkt("b"), mkt("c"), mkt("d")] },
    { event_ticker: "PAIR", mutually_exclusive: true, markets: [mkt("e"), mkt("f")] },
    { event_ticker: "OPEN", mutually_exclusive: false, markets: [mkt("g"), mkt("h")] },
  ];
  assert.deepEqual(selectUniverse(events, 3).map((e) => e.event_ticker), ["PAIR"]);
});
