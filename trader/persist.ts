import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { clientKey } from "../supabase/functions/scan/paper.ts";
import type { ArbOpportunity } from "../supabase/functions/scan/arb.ts";
import type { PlacedOrder } from "./orders.ts";
export interface TraderHeartbeat { tradingEnabled: boolean; env: string; restHost: string; tryingEventTicker: string | null; lastError: string | null; }
export function makeDb(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function writeHeartbeat(db: SupabaseClient, hb: TraderHeartbeat) {
  const { error } = await db.from("demo_trader_status").upsert({
    id: 1, trading_enabled: hb.tradingEnabled, env: hb.env, rest_host: hb.restHost,
    last_heartbeat: new Date().toISOString(), trying_event_ticker: hb.tryingEventTicker, last_error: hb.lastError,
  });
  if (error) throw new Error(`demo_trader_status: ${error.message}`);
}
export async function insertBasket(db: SupabaseClient, opp: ArbOpportunity, status: string): Promise<number> {
  const row = { client_key: clientKey(opp), event_ticker: opp.eventTicker, series_ticker: opp.seriesTicker, title: opp.title, kind: opp.kind, legs: opp.legs, contracts: opp.contracts, cost_cents: opp.costCents, fee_cents: opp.feeCents, guaranteed_payout_cents: opp.guaranteedPayoutCents, locked_pnl_cents: opp.netEdgeCents, status, close_time: opp.closeTime };
  const { data, error } = await db.from("demo_baskets").upsert(row, { onConflict: "client_key" }).select("id").single();
  if (error) throw new Error(`insert demo_baskets: ${error.message}`);
  return data.id as number;
}
export async function updateBasket(db: SupabaseClient, id: number, patch: Record<string, unknown>) {
  const { error } = await db.from("demo_baskets").update({ ...patch, updated_ts: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`update demo_baskets: ${error.message}`);
}
export async function insertOrders(db: SupabaseClient, basketId: number, orders: PlacedOrder[], timeInForce = "fill_or_kill") {
  if (!orders.length) return;
  const rows = orders.map((o) => ({ basket_id: basketId, client_order_id: o.clientOrderId, kalshi_order_id: o.kalshiOrderId, ticker: o.ticker, side: o.side, book_side: o.bookSide, price_cents: o.priceCents, contracts: o.contracts, filled_count: o.fillCount, remaining_count: o.remainingCount, status: o.status, reject_reason: o.rejectReason, time_in_force: timeInForce }));
  const { error } = await db.from("demo_orders").upsert(rows, { onConflict: "client_order_id" });
  if (error) throw new Error(`insert demo_orders: ${error.message}`);
}
export async function insertFills(db: SupabaseClient, basketId: number, orders: PlacedOrder[]) {
  const fills = orders.filter((o) => o.fillCount > 0); if (!fills.length) return;
  const { data: orderRows, error: selErr } = await db.from("demo_orders").select("id, client_order_id").eq("basket_id", basketId);
  if (selErr) throw new Error(`select demo_orders: ${selErr.message}`);
  const byCid = new Map((orderRows ?? []).map((r) => [r.client_order_id as string, r.id as number]));
  const rows = fills.map((o) => ({ basket_id: basketId, order_id: byCid.get(o.clientOrderId) ?? null, kalshi_fill_id: o.kalshiOrderId ? `${o.kalshiOrderId}:fill` : null, ticker: o.ticker, side: o.side, price_cents: o.averageFillPriceCents ?? o.priceCents, count: o.fillCount }));
  const { error } = await db.from("demo_fills").insert(rows);
  if (error) throw new Error(`insert demo_fills: ${error.message}`);
}
export async function alreadyTried(db: SupabaseClient, opp: ArbOpportunity): Promise<boolean> {
  const { data, error } = await db.from("demo_baskets").select("id").eq("client_key", clientKey(opp)).maybeSingle();
  if (error) throw new Error(`select demo_baskets: ${error.message}`);
  return !!data;
}
