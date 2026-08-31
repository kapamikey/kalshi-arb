/**
 * Kill-switch + signer tests for the demo trader.
 *
 * Production Trade API hosts must throw BEFORE any HTTP.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createVerify,
  generateKeyPairSync,
  constants as cryptoConstants,
} from "node:crypto";

import {
  DEFAULT_DEMO_TRADE_BASE,
  DEMO_TRADE_BASES,
  assertDemoTradeBase,
  createKalshiDemoClient,
  dollarsPrice,
  eventOrderBody,
  messageToSign,
  parseBool,
  readTradeEnv,
  signRequest,
  signingPathFor,
  stableClientOrderId,
} from "../supabase/functions/trade/client.ts";

function env(map: Record<string, string | undefined>) {
  return (k: string) => map[k];
}

test("demo allowlist accepts both official demo Trade API bases", () => {
  for (const base of DEMO_TRADE_BASES) {
    assert.equal(assertDemoTradeBase(base), base);
    assert.equal(assertDemoTradeBase(base + "/"), base);
  }
  assert.equal(
    assertDemoTradeBase("https://external-api.demo.kalshi.co/trade-api/v2/"),
    DEFAULT_DEMO_TRADE_BASE,
  );
});

test("production Trade API hosts throw BEFORE any HTTP", () => {
  const fetches: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    fetches.push(String(input));
    throw new Error("HTTP should not run");
  };

  const production = [
    "https://external-api.kalshi.com/trade-api/v2",
    "https://api.elections.kalshi.com/trade-api/v2",
    "https://api.elections.kalshi.com/trade-api/v2/",
    "https://external-api.kalshi.com/trade-api/v2/portfolio/orders",
  ];

  for (const base of production) {
    assert.throws(
      () => assertDemoTradeBase(base),
      /production Trade API host|not a demo Trade API host/,
    );
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
      () =>
        readTradeEnv(
          env({
            KALSHI_API_BASE: base,
            KALSHI_TRADING_ENABLED: "false",
          }),
        ),
      /production Trade API host|not a demo Trade API host/,
    );
  }

  assert.equal(fetches.length, 0, "production URL must not touch the network");
});

test("unknown hosts are not silently accepted", () => {
  assert.throws(
    () => assertDemoTradeBase("https://example.com/trade-api/v2"),
    /not a demo Trade API host/,
  );
});

test("trading disabled starts with empty keys and places zero HTTP", () => {
  const cfg = readTradeEnv(
    env({
      KALSHI_TRADING_ENABLED: "false",
      KALSHI_API_KEY_ID: "",
      KALSHI_PRIVATE_KEY: "",
    }),
  );
  assert.equal(cfg.tradingEnabled, false);
  assert.equal(cfg.apiBase, DEFAULT_DEMO_TRADE_BASE);
  assert.equal(cfg.apiKeyId, "");
  assert.equal(cfg.privateKeyPem, "");
});

test("KALSHI_TRADING_ENABLED defaults to false", () => {
  const cfg = readTradeEnv(env({}));
  assert.equal(cfg.tradingEnabled, false);
  assert.equal(parseBool(undefined, false), false);
});

test("trading enabled with empty keys fails clearly before HTTP", () => {
  const fetches: string[] = [];
  assert.throws(
    () =>
      readTradeEnv(
        env({
          KALSHI_TRADING_ENABLED: "true",
          KALSHI_API_KEY_ID: "",
          KALSHI_PRIVATE_KEY: "",
        }),
      ),
    /KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY is empty/,
  );
  assert.throws(
    () =>
      readTradeEnv(
        env({
          KALSHI_TRADING_ENABLED: "true",
          KALSHI_API_KEY_ID: "abc",
          KALSHI_PRIVATE_KEY: "",
        }),
      ),
    /empty/,
  );
  assert.equal(fetches.length, 0);
});

test("signing path includes /trade-api/v2 and strips the query string", () => {
  const path = signingPathFor(
    DEFAULT_DEMO_TRADE_BASE,
    "/portfolio/events/orders?limit=5",
  );
  assert.equal(path, "/trade-api/v2/portfolio/events/orders");
  assert.equal(
    messageToSign("1703123456789", "POST", path + "?limit=5"),
    "1703123456789POST/trade-api/v2/portfolio/events/orders",
  );
});

test("RSA-PSS SHA256 signer matches Kalshi header construction", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const timestamp = "1703123456789";
  const path = "/trade-api/v2/portfolio/events/orders";
  const sig = signRequest(privateKey, timestamp, "POST", path);
  assert.match(sig, /^[A-Za-z0-9+/]+=*$/);

  const verify = createVerify("RSA-SHA256");
  verify.update(messageToSign(timestamp, "POST", path));
  verify.end();
  assert.equal(
    verify.verify(
      {
        key: publicKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      },
      sig,
      "base64",
    ),
    true,
  );
});

test("signed POST attaches Kalshi headers and never uses GTC", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  const saw: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    saw.push({
      url: String(input),
      method: String(init?.method),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response(
      JSON.stringify({
        order_id: "ord-1",
        fill_count: "1.00",
        remaining_count: "0.00",
        ts_ms: 1,
      }),
      { status: 201 },
    );
  };

  const client = createKalshiDemoClient({
    apiBase: DEFAULT_DEMO_TRADE_BASE,
    apiKeyId: "key-id-123",
    privateKeyPem: privateKey,
    fetch: fakeFetch,
    nowMs: () => 1703123456789,
  });

  const body = eventOrderBody(
    { ticker: "MKT", side: "yes", priceCents: 45 },
    "cid-1",
  );
  const res = await client.createEventOrder(body);
  assert.equal(res.status, 201);
  assert.equal(saw.length, 1);
  const got = saw[0];
  assert.equal(got.url, `${DEFAULT_DEMO_TRADE_BASE}/portfolio/events/orders`);
  assert.equal(got.method, "POST");
  assert.equal(got.headers.get("KALSHI-ACCESS-KEY"), "key-id-123");
  assert.equal(got.headers.get("KALSHI-ACCESS-TIMESTAMP"), "1703123456789");
  assert.ok(got.headers.get("KALSHI-ACCESS-SIGNATURE"));
  const parsed = JSON.parse(got.body) as { time_in_force: string };
  assert.equal(parsed.time_in_force, "fill_or_kill");
  assert.notEqual(parsed.time_in_force, "good_till_canceled");
});

test("YES/NO legs map onto the V2 YES book (bid vs ask at 1-p)", () => {
  const yes = eventOrderBody(
    { ticker: "A", side: "yes", priceCents: 45 },
    "c1",
  );
  assert.equal(yes.side, "bid");
  assert.equal(yes.price, "0.4500");
  assert.equal(yes.count, "1.00");
  assert.equal(yes.time_in_force, "fill_or_kill");

  const no = eventOrderBody(
    { ticker: "B", side: "no", priceCents: 40 },
    "c2",
  );
  assert.equal(no.side, "ask");
  assert.equal(no.price, "0.6000");
  assert.equal(dollarsPrice(1), "0.0100");
});

test("client_order_id is stable for the same basket/leg", async () => {
  const a = await stableClientOrderId("EVT#overround|A|yes|45|1");
  const b = await stableClientOrderId("EVT#overround|A|yes|45|1");
  const c = await stableClientOrderId("EVT#overround|A|yes|46|1");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("demo event fetch hits the demo host, not production", async () => {
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    urls.push(String(input));
    return Response.json({
      events: [
        {
          event_ticker: "DEMO-1",
          mutually_exclusive: true,
          markets: [{ ticker: "A" }, { ticker: "B" }],
        },
      ],
    });
  };
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const client = createKalshiDemoClient({
    apiBase: "https://demo-api.kalshi.co/trade-api/v2",
    apiKeyId: "k",
    privateKeyPem: privateKey,
    fetch: fakeFetch,
  });
  const events = await client.fetchCappedExclusiveEvents(20);
  assert.equal(events.length, 1);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/demo-api\.kalshi\.co\/trade-api\/v2\/events/);
  assert.doesNotMatch(urls[0], /elections\.kalshi\.com|external-api\.kalshi\.com/);
});
