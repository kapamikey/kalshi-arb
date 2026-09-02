/**
 * Demo paper trader. 30-second cron, demo books + demo orders only.
 *
 * Off by default (KALSHI_TRADING_ENABLED). Production Trade API hosts crash
 * on boot before any HTTP. The public 5-minute `scan` function is unchanged
 * and still has no Kalshi credentials.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { DEFAULT_SCAN_CONFIG, scanEvent, type ArbOpportunity } from "../scan/arb.ts";
import { clientKey } from "../scan/paper.ts";
import {
  DEMO_LOT,
  kalshiTakerFeeCents,
  priceOpportunity,
  type CosResult,
  type PricedOpportunity,
} from "../scan/fees.ts";
import {
  TRADER_STATUS_BASKET,
  TRADER_STATUS_CLIENT_ID,
  createKalshiDemoClient,
  eventOrderBody,
  readTradeEnv,
  stableClientOrderId,
  type DemoKalshiClient,
} from "./client.ts";

const CONTRACTS = DEMO_LOT;

// Boot-time kill-switch: production host or enabled-without-keys fails the isolate.
readTradeEnv((k) => Deno.env.get(k));

const TIME_BUDGET_MS = 40_000;

type TraderStatus = "off" | "watching" | "submitted" | "rejected";

type DemoOrderRow = {
  basket_id: string;
  ticker: string;
  side: string;
  status: string;
  kalshi_order_id: string | null;
  reject_reason: string | null;
  ts: string;
  event_ticker: string | null;
  kind: string | null;
  client_order_id: string;
  contracts: number;
  price_cents: number | null;
  fee_cents: number;
  fee_multiplier: number | null;
  fee_type: string | null;
  realized_pnl_cents: number | null;
  result: CosResult;
  confidence: number | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

async function upsertTraderStatus(
  db: SupabaseClient,
  row: {
    status: TraderStatus;
    ts: string;
    event_ticker?: string | null;
    kind?: string | null;
    reject_reason?: string | null;
  },
) {
  const payload: DemoOrderRow = {
    basket_id: TRADER_STATUS_BASKET,
    ticker: "_",
    side: "status",
    status: row.status,
    kalshi_order_id: null,
    reject_reason: row.reject_reason ?? null,
    ts: row.ts,
    event_ticker: row.event_ticker ?? null,
    kind: row.kind ?? null,
    client_order_id: TRADER_STATUS_CLIENT_ID,
    contracts: CONTRACTS,
    price_cents: null,
    fee_cents: 0,
    fee_multiplier: null,
    fee_type: null,
    realized_pnl_cents: null,
    result: row.status === "rejected" ? "rejected" : "open",
    confidence: null,
  };
  const { error } = await db.from("demo_orders").upsert(payload, {
    onConflict: "client_order_id",
  });
  if (error) throw new Error(`upsert demo trader status: ${error.message}`);
}

async function insertOrder(db: SupabaseClient, row: DemoOrderRow) {
  const { error } = await db.from("demo_orders").upsert(row, {
    onConflict: "client_order_id",
  });
  if (error) throw new Error(`upsert demo_orders: ${error.message}`);
}

function rejectText(
  status: number,
  json: { message?: string; error?: string },
  text: string,
): string {
  return json.message || json.error || text.slice(0, 180) || `HTTP ${status}`;
}

function fillCount(json: { fill_count?: string }): number {
  const n = Number.parseFloat(json.fill_count ?? "0");
  return Number.isFinite(n) ? n : 0;
}

function remainingCount(json: { remaining_count?: string }): number {
  const n = Number.parseFloat(json.remaining_count ?? "0");
  return Number.isFinite(n) ? n : 0;
}

async function alreadyWorked(db: SupabaseClient, basketId: string): Promise<boolean> {
  const { data, error } = await db
    .from("demo_orders")
    .select("id, status")
    .eq("basket_id", basketId)
    .in("status", ["submitted", "filled"])
    .limit(1);
  if (error) throw new Error(`select demo_orders: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

async function placeBasket(
  db: SupabaseClient,
  client: DemoKalshiClient,
  opp: PricedOpportunity,
  ts: string,
): Promise<{ ok: boolean; reason?: string }> {
  const basketId = clientKey(opp);

  for (const leg of opp.legs) {
    const clientOrderId = await stableClientOrderId(
      `${basketId}|${leg.ticker}|${leg.side}|${leg.priceCents}|${CONTRACTS}`,
    );
    const fee_cents = await kalshiTakerFeeCents(db, {
      contracts: CONTRACTS,
      price_cents: leg.priceCents,
      fee_multiplier: leg.fee_multiplier,
    });
    const attempted: DemoOrderRow = {
      basket_id: basketId,
      ticker: leg.ticker,
      side: leg.side,
      status: "attempted",
      kalshi_order_id: null,
      reject_reason: null,
      ts,
      event_ticker: opp.eventTicker,
      kind: opp.kind,
      client_order_id: clientOrderId,
      contracts: CONTRACTS,
      price_cents: leg.priceCents,
      fee_cents,
      fee_multiplier: leg.fee_multiplier,
      fee_type: leg.fee_type,
      realized_pnl_cents: null,
      result: "open",
      confidence: opp.confidence,
    };
    await insertOrder(db, attempted);

    const body = eventOrderBody(
      { ticker: leg.ticker, side: leg.side, priceCents: leg.priceCents },
      clientOrderId,
    );
    const res = await client.createEventOrder(body);
    const json = res.json as {
      order_id?: string;
      fill_count?: string;
      remaining_count?: string;
      message?: string;
      error?: string;
    };

    if (res.status === 409) {
      await insertOrder(db, {
        ...attempted,
        status: "submitted",
        kalshi_order_id: json.order_id ?? null,
        reject_reason: "idempotent replay (client_order_id already exists)",
      });
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      const filled = fillCount(json);
      const remaining = remainingCount(json);
      if (remaining > 0 && json.order_id) {
        try {
          await client.cancelEventOrder(json.order_id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await insertOrder(db, {
            ...attempted,
            status: "rejected",
            result: "rejected",
            kalshi_order_id: json.order_id ?? null,
            reject_reason: `remainder cancel failed: ${message}`,
          });
          return { ok: false, reason: `remainder cancel failed: ${message}` };
        }
      }
      if (filled <= 0) {
        const reason = "unfilled (fill_or_kill)";
        await insertOrder(db, {
          ...attempted,
          status: "rejected",
          result: "rejected",
          kalshi_order_id: json.order_id ?? null,
          reject_reason: reason,
        });
        return { ok: false, reason };
      }
      await insertOrder(db, {
        ...attempted,
        status: remaining > 0 ? "submitted" : "filled",
        kalshi_order_id: json.order_id ?? null,
        reject_reason: remaining > 0 ? "canceled remainder in-run" : null,
      });
      continue;
    }

    const reason = rejectText(res.status, json, res.text);
    await insertOrder(db, {
      ...attempted,
      status: "rejected",
      result: "rejected",
      kalshi_order_id: json.order_id ?? null,
      reject_reason: reason,
    });
    return { ok: false, reason };
  }

  return { ok: true };
}

async function run(): Promise<Response> {
  const started = Date.now();
  const ts = nowIso();
  const env = readTradeEnv((k) => Deno.env.get(k));

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  if (!env.tradingEnabled) {
    await upsertTraderStatus(db, { status: "off", ts });
    return Response.json({
      ok: true,
      trading: false,
      placed: 0,
      duration_ms: Date.now() - started,
    });
  }

  const client = createKalshiDemoClient({
    apiBase: env.apiBase,
    apiKeyId: env.apiKeyId,
    privateKeyPem: env.privateKeyPem,
  });

  try {
    const events = await client.fetchCappedExclusiveEvents(env.eventCap);
    const cfg = { ...DEFAULT_SCAN_CONFIG, contracts: CONTRACTS };
    const opportunities = events
      .flatMap((e) => scanEvent(e, cfg))
      .sort((a, b) => b.netEdgeCents - a.netEdgeCents);

    if (!opportunities.length) {
      await upsertTraderStatus(db, { status: "watching", ts });
      return Response.json({
        ok: true,
        trading: true,
        events: events.length,
        opportunities: 0,
        placed: 0,
        duration_ms: Date.now() - started,
      });
    }

    let placed = 0;
    let lastReject: string | undefined;
    let lastOpp: ArbOpportunity | undefined;

    for (const opp of opportunities) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      if (await alreadyWorked(db, clientKey(opp))) continue;
      lastOpp = opp;
      const priced = await priceOpportunity(db, opp);
      const result = await placeBasket(db, client, priced, ts);
      if (result.ok) {
        placed++;
        await upsertTraderStatus(db, {
          status: "submitted",
          ts,
          event_ticker: opp.eventTicker,
          kind: opp.kind,
        });
        break;
      }
      lastReject = result.reason;
      await upsertTraderStatus(db, {
        status: "rejected",
        ts,
        event_ticker: opp.eventTicker,
        kind: opp.kind,
        reject_reason: result.reason,
      });
      break;
    }

    if (placed === 0 && !lastReject) {
      await upsertTraderStatus(db, { status: "watching", ts });
    }

    return Response.json({
      ok: true,
      trading: true,
      events: events.length,
      opportunities: opportunities.length,
      placed,
      event: lastOpp?.eventTicker ?? null,
      kind: lastOpp?.kind ?? null,
      reject: lastReject ?? null,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertTraderStatus(db, {
      status: "rejected",
      ts,
      reject_reason: message,
    });
    return Response.json(
      { ok: false, trading: true, error: message, duration_ms: Date.now() - started },
      { status: 500 },
    );
  }
}

Deno.serve(async () => {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
});
