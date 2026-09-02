/**
 * Human Skip / Approve for the ticket desk.
 *
 * verify_jwt=true. Keys never leave the server. Demo host allowlist only.
 * 1 lot per leg, FOK. Partial fills are inventory, not a locked arb.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  createKalshiDemoClient,
  eventOrderBody,
  readTradeEnv,
  stableClientOrderId,
  type DemoKalshiClient,
} from "../trade/client.ts";
import {
  approveBlockedReason,
  type TicketLeg,
} from "../trade/tickets.ts";

type TicketRow = {
  id: number;
  event_ticker: string;
  title: string | null;
  kind: string;
  legs: TicketLeg[];
  quoted_ts: string;
  fee_cents: number;
  net_edge_cents: number;
  optimistic_pnl_cents: number;
  conservative_pnl_cents: number | null;
  status: string;
  demo_order_ids: number[] | null;
};

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders(req) });
}

function fillCount(json: { fill_count?: string }): number {
  const n = Number.parseFloat(json.fill_count ?? "0");
  return Number.isFinite(n) ? n : 0;
}

function remainingCount(json: { remaining_count?: string }): number {
  const n = Number.parseFloat(json.remaining_count ?? "0");
  return Number.isFinite(n) ? n : 0;
}

function rejectText(
  status: number,
  parsed: { message?: string; error?: string },
  text: string,
): string {
  return parsed.message || parsed.error || text.slice(0, 180) || `HTTP ${status}`;
}

function envNamesForApprove(): { keyId: string; pem: string } {
  const get = (k: string) => Deno.env.get(k);
  const keyId = (get("KALSHI_DEMO_KEY_ID") || get("KALSHI_API_KEY_ID") || "").trim();
  const pemName = get("KALSHI_DEMO_PRIVATE_KEY_PEM")
    ? "KALSHI_DEMO_PRIVATE_KEY_PEM"
    : get("KALSHI_PRIVATE_KEY")
    ? "KALSHI_PRIVATE_KEY"
    : "";
  return {
    keyId: keyId ? "present" : "",
    pem: pemName,
  };
}

async function placeLegs(
  db: ReturnType<typeof createClient>,
  client: DemoKalshiClient,
  ticket: TicketRow,
  ts: string,
): Promise<{
  fill: "filled" | "rejected" | "partial";
  locked_arb: boolean;
  order_ids: number[];
  reasons: string[];
}> {
  const legs = Array.isArray(ticket.legs) ? ticket.legs : [];
  const orderIds: number[] = [];
  const reasons: string[] = [];
  let filledLegs = 0;
  let rejectedLegs = 0;

  for (const leg of legs) {
    const clientOrderId = await stableClientOrderId(
      `ticket:${ticket.id}|${leg.ticker}|${leg.side}|${leg.ask_cents}|1`,
    );
    const attempted = {
      basket_id: `ticket:${ticket.id}`,
      ticker: leg.ticker,
      side: leg.side,
      status: "attempted",
      kalshi_order_id: null as string | null,
      reject_reason: null as string | null,
      ts,
      event_ticker: ticket.event_ticker,
      kind: ticket.kind,
      client_order_id: clientOrderId,
    };
    const ins = await db.from("demo_orders").upsert(attempted, {
      onConflict: "client_order_id",
    }).select("id").single();
    if (ins.error) throw new Error(`insert demo_orders: ${ins.error.message}`);
    if (ins.data?.id) orderIds.push(ins.data.id as number);

    const body = eventOrderBody(
      { ticker: leg.ticker, side: leg.side, priceCents: leg.ask_cents },
      clientOrderId,
    );
    const res = await client.createEventOrder(body);
    const parsed = res.json as {
      order_id?: string;
      fill_count?: string;
      remaining_count?: string;
      message?: string;
      error?: string;
    };

    let status = "rejected";
    let reason: string | null = null;
    if (res.status === 409) {
      status = "submitted";
      reason = "idempotent replay (client_order_id already exists)";
      filledLegs++;
    } else if (res.status >= 200 && res.status < 300) {
      const filled = fillCount(parsed);
      const remaining = remainingCount(parsed);
      if (remaining > 0 && parsed.order_id) {
        try {
          await client.cancelEventOrder(parsed.order_id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          status = "rejected";
          reason = `remainder cancel failed: ${message}`;
          rejectedLegs++;
          reasons.push(reason);
          await db.from("demo_orders").upsert({
            ...attempted,
            status,
            kalshi_order_id: parsed.order_id ?? null,
            reject_reason: reason,
          }, { onConflict: "client_order_id" });
          continue;
        }
      }
      if (filled <= 0) {
        status = "rejected";
        reason = "unfilled (fill_or_kill)";
        rejectedLegs++;
      } else if (remaining > 0) {
        status = "submitted";
        reason = "canceled remainder in-run";
        filledLegs++;
      } else {
        status = "filled";
        filledLegs++;
      }
    } else {
      status = "rejected";
      reason = rejectText(res.status, parsed, res.text);
      rejectedLegs++;
    }
    if (reason) reasons.push(reason);
    await db.from("demo_orders").upsert({
      ...attempted,
      status,
      kalshi_order_id: parsed.order_id ?? null,
      reject_reason: reason,
    }, { onConflict: "client_order_id" });
  }

  const fill =
    rejectedLegs === 0 && filledLegs === legs.length
      ? "filled"
      : filledLegs === 0
      ? "rejected"
      : "partial";
  return {
    fill,
    locked_arb: fill === "filled",
    order_ids: orderIds,
    reasons,
  };
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return json(req, { ok: false, error: "POST only" }, 405);
  }

  let body: { ticket_id?: number; action?: string } = {};
  try {
    body = (await req.json()) as { ticket_id?: number; action?: string };
  } catch {
    return json(req, { ok: false, error: "invalid JSON" }, 400);
  }

  const action = (body.action ?? "approve").toLowerCase();
  const ticketId = Number(body.ticket_id);
  if (!Number.isFinite(ticketId) || ticketId <= 0) {
    return json(req, { ok: false, error: "ticket_id required" }, 400);
  }
  if (action !== "skip" && action !== "approve") {
    return json(req, { ok: false, error: "action must be skip or approve" }, 400);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await db.from("tickets").select("*").eq("id", ticketId).maybeSingle();
  if (error) return json(req, { ok: false, error: error.message }, 500);
  if (!data) return json(req, { ok: false, error: "ticket not found" }, 404);
  const ticket = data as TicketRow;

  if (action === "skip") {
    if (ticket.status !== "open") {
      return json(req, { ok: false, error: `cannot skip ${ticket.status}` }, 409);
    }
    const { error: upErr } = await db.from("tickets").update({ status: "skipped" }).eq("id", ticket.id);
    if (upErr) return json(req, { ok: false, error: upErr.message }, 500);
    return json(req, { ok: true, action: "skip", status: "skipped", ticket_id: ticket.id });
  }

  const blocked = approveBlockedReason({
    quoted_ts: ticket.quoted_ts,
    legs: ticket.legs,
    conservative_pnl_cents: ticket.conservative_pnl_cents,
    optimistic_pnl_cents: ticket.optimistic_pnl_cents,
    net_edge_cents: ticket.net_edge_cents,
    status: ticket.status,
  });
  if (blocked) {
    return json(req, { ok: false, error: `reject: ${blocked}` }, 409);
  }

  // Kill-switch: production hosts throw before HTTP. Keys used only here.
  let env;
  try {
    env = readTradeEnv((k) => Deno.env.get(k));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(req, { ok: false, error: message }, 500);
  }

  const names = envNamesForApprove();
  if (!env.apiKeyId || !env.privateKeyPem) {
    const missing: string[] = [];
    if (!names.keyId) missing.push("KALSHI_DEMO_KEY_ID");
    if (!names.pem) missing.push("KALSHI_DEMO_PRIVATE_KEY_PEM");
    return json(
      req,
      {
        ok: false,
        error: `Approve cannot boot: missing ${missing.join(" and ")} (names only; values never logged)`,
        missing_env: missing,
      },
      500,
    );
  }

  const client = createKalshiDemoClient({
    apiBase: env.apiBase,
    apiKeyId: env.apiKeyId,
    privateKeyPem: env.privateKeyPem,
  });

  const ts = new Date().toISOString();
  const result = await placeLegs(db, client, ticket, ts);
  const { error: upErr } = await db
    .from("tickets")
    .update({ status: "approved", demo_order_ids: result.order_ids })
    .eq("id", ticket.id);
  if (upErr) return json(req, { ok: false, error: upErr.message }, 500);

  return json(req, {
    ok: true,
    action: "approve",
    status: "approved",
    fill: result.fill,
    locked_arb: result.locked_arb,
    ticket_id: ticket.id,
    demo_order_ids: result.order_ids,
    note: result.fill === "partial"
      ? "Partial is inventory, not a locked arb."
      : undefined,
  });
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(req, { ok: false, error: message }, 500);
  }
});
