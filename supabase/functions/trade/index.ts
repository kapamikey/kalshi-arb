/**
 * 30-second ticket refresh. Production books + depth; NEVER places orders.
 *
 * Demo Trade API POSTs belong on the human Approve path (`approve` function).
 * Production Trade API hosts still crash the isolate at boot (kill-switch).
 * Demo books are not ticket prices.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  fetchExclusiveOpenEvents,
  fetchOrderbook,
  fetchSeries,
  mapPool,
  type DisplayedAsks,
  type KalshiEvent,
} from "../scan/kalshi.ts";
import {
  CRON_POSTS_ORDERS,
  TICKET_TTL_MS,
  scoreEventTickets,
  seriesAllowed,
  type TicketDraft,
} from "./tickets.ts";
import {
  TRADER_STATUS_BASKET,
  TRADER_STATUS_CLIENT_ID,
  readTradeEnv,
} from "./client.ts";

// Boot-time kill-switch: production Trade API host fails the isolate before HTTP.
readTradeEnv((k) => Deno.env.get(k));

const TIME_BUDGET_MS = 45_000;
const EVENT_CAP = 20;
const ORDERBOOK_CONCURRENCY = 12;

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
};

function nowIso(): string {
  return new Date().toISOString();
}

async function upsertTraderStatus(
  db: SupabaseClient,
  row: { status: string; ts: string; reject_reason?: string | null },
) {
  const payload: DemoOrderRow = {
    basket_id: TRADER_STATUS_BASKET,
    ticker: "_",
    side: "status",
    status: row.status,
    kalshi_order_id: null,
    reject_reason: row.reject_reason ?? null,
    ts: row.ts,
    event_ticker: null,
    kind: null,
    client_order_id: TRADER_STATUS_CLIENT_ID,
  };
  const { error } = await db.from("demo_orders").upsert(payload, {
    onConflict: "client_order_id",
  });
  if (error) throw new Error(`upsert demo trader status: ${error.message}`);
}

async function expireStaleOpen(db: SupabaseClient, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - TICKET_TTL_MS).toISOString();
  const { data, error } = await db
    .from("tickets")
    .update({ status: "expired" })
    .eq("status", "open")
    .lt("quoted_ts", cutoff)
    .select("id");
  if (error) throw new Error(`expire tickets: ${error.message}`);
  return data?.length ?? 0;
}

async function replaceOpenTickets(db: SupabaseClient, drafts: TicketDraft[], ts: string) {
  const { error: closeErr } = await db
    .from("tickets")
    .update({ status: "expired" })
    .eq("status", "open");
  if (closeErr) throw new Error(`close prior tickets: ${closeErr.message}`);

  if (!drafts.length) return 0;
  const rows = drafts.map((d) => ({
    event_ticker: d.event_ticker,
    title: d.title,
    kind: d.kind,
    legs: d.legs,
    quoted_ts: d.quoted_ts || ts,
    fee_cents: d.fee_cents,
    net_edge_cents: d.net_edge_cents,
    optimistic_pnl_cents: d.optimistic_pnl_cents,
    conservative_pnl_cents: d.conservative_pnl_cents,
    status: "open",
    demo_order_ids: null,
  }));
  const { data, error } = await db.from("tickets").insert(rows).select("id");
  if (error) throw new Error(`insert tickets: ${error.message}`);
  return data?.length ?? 0;
}

export async function refreshTickets(opts: {
  db: SupabaseClient;
  started: number;
  ts: string;
}): Promise<{ events: number; books: number; written: number; expired: number }> {
  if (CRON_POSTS_ORDERS) {
    throw new Error("Ticket cron must not POST; CRON_POSTS_ORDERS is a tripwire");
  }

  const expired = await expireStaleOpen(opts.db, opts.started);
  const cap = Math.max(1, Math.min(
    Number.parseInt(Deno.env.get("DEMO_EVENT_CAP") ?? "", 10) || EVENT_CAP,
    EVENT_CAP,
  ));

  const events = await fetchExclusiveOpenEvents(cap);
  const seriesTickers = [...new Set(events.map((e) => e.series_ticker ?? "").filter(Boolean))];
  const seriesMap = new Map<string, Awaited<ReturnType<typeof fetchSeries>>>();
  await mapPool(seriesTickers, 8, async (t) => {
    seriesMap.set(t, await fetchSeries(t));
    return t;
  });

  const usable: KalshiEvent[] = [];
  const feeByEvent = new Map<string, number>();
  for (const e of events) {
    if (Date.now() - opts.started > TIME_BUDGET_MS) break;
    const allowed = seriesAllowed(seriesMap.get(e.series_ticker ?? "") ?? null, e.series_ticker ?? "");
    if (!allowed.ok) continue;
    usable.push(e);
    feeByEvent.set(e.event_ticker, allowed.feeRate);
  }

  const tickers: string[] = [];
  for (const e of usable) {
    for (const m of e.markets ?? []) tickers.push(m.ticker);
  }

  const books = new Map<string, DisplayedAsks>();
  await mapPool(tickers, ORDERBOOK_CONCURRENCY, async (ticker) => {
    if (Date.now() - opts.started > TIME_BUDGET_MS) return ticker;
    try {
      books.set(ticker, await fetchOrderbook(ticker));
    } catch {
      // missing book → depth unknown → no ticket for that event
    }
    return ticker;
  });

  const drafts: TicketDraft[] = [];
  for (const e of usable) {
    const feeRate = feeByEvent.get(e.event_ticker);
    if (feeRate == null) continue;
    drafts.push(...scoreEventTickets(e, books, feeRate, opts.ts));
  }

  const written = await replaceOpenTickets(opts.db, drafts, opts.ts);
  return { events: events.length, books: books.size, written, expired };
}

async function run(): Promise<Response> {
  const started = Date.now();
  const ts = nowIso();
  readTradeEnv((k) => Deno.env.get(k));

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const result = await refreshTickets({ db, started, ts });
    await upsertTraderStatus(db, { status: "watching", ts });
    return Response.json({
      ok: true,
      posted: false,
      cron_posts_orders: CRON_POSTS_ORDERS,
      ...result,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertTraderStatus(db, { status: "watching", ts, reject_reason: message });
    return Response.json(
      { ok: false, posted: false, error: message, duration_ms: Date.now() - started },
      { status: 500 },
    );
  }
}

Deno.serve(async () => {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, posted: false, error: message }, { status: 500 });
  }
});
