import { createHash } from "node:crypto";
import type { ArbLeg, ArbOpportunity } from "../supabase/functions/scan/arb.ts";
import type { DemoKalshiClient } from "./client.ts";
import { KalshiError } from "./client.ts";
import type { TimeInForce } from "./env.ts";
export interface CreateOrderResponse { order_id: string; client_order_id?: string; fill_count?: string; remaining_count?: string; average_fill_price?: string; ts_ms?: number; }
export interface PlacedOrder {
  clientOrderId: string; kalshiOrderId: string | null; ticker: string; side: "yes" | "no"; bookSide: "bid" | "ask";
  priceCents: number; contracts: number; fillCount: number; remainingCount: number;
  status: "submitted" | "filled" | "partial" | "failed" | "canceled"; rejectReason: string | null; averageFillPriceCents: number | null;
}
function fpCount(n: number): string { return n.toFixed(2); }
function fpDollarsFromCents(cents: number): string { return (cents / 100).toFixed(4); }
function parseFp(raw: string | number | undefined, fallback = 0): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}
export function clientOrderId(basketKey: string, ticker: string, side: string): string {
  const h = createHash("sha256").update(`${basketKey}|${ticker}|${side}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function v2OrderBody(leg: ArbLeg, opts: { clientOrderId: string; timeInForce: TimeInForce }) {
  const bookSide: "bid" | "ask" = leg.side === "yes" ? "bid" : "ask";
  const yesPriceCents = leg.side === "yes" ? leg.priceCents : 100 - leg.priceCents;
  return { ticker: leg.ticker, side: bookSide, count: fpCount(leg.contracts), price: fpDollarsFromCents(yesPriceCents),
    time_in_force: opts.timeInForce, self_trade_prevention_type: "taker_at_cross", client_order_id: opts.clientOrderId };
}
export interface PlaceDeps { client: DemoKalshiClient; timeInForce: TimeInForce; }
export async function placeLeg(deps: PlaceDeps, basketKey: string, leg: ArbLeg): Promise<PlacedOrder> {
  const cid = clientOrderId(basketKey, leg.ticker, leg.side);
  const body = v2OrderBody(leg, { clientOrderId: cid, timeInForce: deps.timeInForce });
  const base = { clientOrderId: cid, ticker: leg.ticker, side: leg.side, bookSide: body.side, priceCents: leg.priceCents, contracts: leg.contracts, averageFillPriceCents: null as number | null };
  try {
    const res = await deps.client.signed<CreateOrderResponse>("POST", "/portfolio/events/orders", body);
    const fillCount = parseFp(res.fill_count); const remaining = parseFp(res.remaining_count);
    let status: PlacedOrder["status"] = "submitted";
    if (fillCount >= leg.contracts - 0.001 && remaining <= 0.001) status = "filled";
    else if (fillCount > 0) status = "partial";
    else if (remaining <= 0.001) status = "failed";
    return { ...base, kalshiOrderId: res.order_id ?? null, fillCount, remainingCount: remaining, status,
      rejectReason: status === "failed" ? "unfilled (IOC/FOK)" : null,
      averageFillPriceCents: res.average_fill_price != null ? Math.round(parseFp(res.average_fill_price) * 100) : null };
  } catch (err) {
    if (err instanceof KalshiError && err.status === 409) {
      return { ...base, kalshiOrderId: null, fillCount: 0, remainingCount: 0, status: "submitted", rejectReason: "409 duplicate client_order_id" };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return { ...base, kalshiOrderId: null, fillCount: 0, remainingCount: 0, status: "failed", rejectReason: reason.slice(0, 400) };
  }
}
export async function cancelOrder(client: DemoKalshiClient, orderId: string, marketTicker: string): Promise<void> {
  try { await client.signed("DELETE", `/portfolio/events/orders/${orderId}?market_ticker=${encodeURIComponent(marketTicker)}`); }
  catch (err) { if (err instanceof KalshiError && (err.status === 404 || err.status === 409)) return; throw err; }
}
export type BasketOutcome = "skipped" | "filled" | "partial" | "failed";
export interface ExecuteResult { outcome: BasketOutcome; ordersPlaced: number; orders: PlacedOrder[]; failReason: string | null; }
export async function executeBasket(deps: PlaceDeps & { tradingEnabled: boolean }, basketKey: string, opp: ArbOpportunity): Promise<ExecuteResult> {
  if (!deps.tradingEnabled) return { outcome: "skipped", ordersPlaced: 0, orders: [], failReason: null };
  const orders: PlacedOrder[] = [];
  for (const leg of opp.legs) orders.push(await placeLeg(deps, basketKey, leg));
  const allFilled = orders.every((o) => o.status === "filled");
  const anyFill = orders.some((o) => o.fillCount > 0);
  if (!allFilled) {
    for (const o of orders) {
      if (o.kalshiOrderId && o.status !== "filled" && o.remainingCount > 0) {
        try { await cancelOrder(deps.client, o.kalshiOrderId, o.ticker); if (o.status === "submitted") o.status = "canceled"; }
        catch (err) { const reason = err instanceof Error ? err.message : String(err); o.rejectReason = ((o.rejectReason ? o.rejectReason + "; " : "") + `cancel failed: ${reason}`).slice(0, 400); }
      }
    }
  }
  if (allFilled) return { outcome: "filled", ordersPlaced: orders.length, orders, failReason: null };
  const first = orders.find((o) => o.status === "failed" || o.status === "partial" || o.status === "canceled");
  return { outcome: anyFill && !allFilled ? "partial" : "failed", ordersPlaced: orders.length, orders, failReason: first?.rejectReason ?? "leg did not fill; canceled rest" };
}
