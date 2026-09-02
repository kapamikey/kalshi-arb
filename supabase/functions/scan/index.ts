/**
 * Scheduled scanner entrypoint.
 *
 * One invocation:
 *   1. pulls every open event with nested markets from Kalshi (read-only),
 *   2. snapshots every market book (the data-collection job),
 *   3. runs arb detection per event,
 *   4. opens paper positions for baskets clearing the edge threshold,
 *   5. settles paper positions whose markets have resolved,
 *   6. writes an equity point to portfolio_snapshots (paper = true).
 *   7. POSTs the `trade` function once (same Bearer as cron). Trade errors
 *      are logged and never fail the scan.
 *
 * Scan itself never authenticates to Kalshi and never places an order.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { fetchMarketsByTickers, fetchOpenEvents, type KalshiEvent } from "./kalshi.ts";
import { DEFAULT_SCAN_CONFIG, scanEvent, type ScanConfig } from "./arb.ts";
import { clientKey, settlePosition } from "./paper.ts";
import {
  DEMO_LOT,
  confidenceFromEdge,
  priceAllOpportunities,
  settleResult,
  type PricedOpportunity,
} from "./fees.ts";
import { insertOpportunities, opportunityRow } from "./opportunities.ts";

const PAPER_STARTING_BANKROLL_CENTS = 100_000; // $1,000, matching existing paper rows
const TRADE_TIMEOUT_MS = 50_000;

/** One demo trade after this scan. Never throws; never logs secrets. */
async function invokeTradeOnce(): Promise<unknown> {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!base || !key) {
    console.warn("skip trade invoke: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return { ok: false, error: "missing supabase url or service role" };
  }
  const url = `${base}/functions/v1/trade`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(TRADE_TIMEOUT_MS),
    });
    const bodyText = await res.text();
    console.log(`trade invoke status=${res.status} body=${bodyText.slice(0, 2000)}`);
    try {
      return JSON.parse(bodyText);
    } catch {
      return { ok: false, error: `trade HTTP ${res.status} non-json` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`trade invoke failed: ${message}`);
    return { ok: false, error: message };
  }
}


function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function config(): ScanConfig {
  return {
    ...DEFAULT_SCAN_CONFIG,
    minNetEdgeCents: envInt("MIN_NET_EDGE_CENTS", DEFAULT_SCAN_CONFIG.minNetEdgeCents),
    // Demo / CoS paper book is 1 lot per leg. Detection tests still use DEFAULT 20.
    contracts: envInt("CONTRACTS", DEMO_LOT),
  };
}

function snapshotRows(runId: number, events: KalshiEvent[], ts: string) {
  return events.flatMap((event) =>
    (event.markets ?? []).map((m) => ({
      run_id: runId,
      ts,
      ticker: m.ticker,
      event_ticker: m.event_ticker ?? event.event_ticker,
      series_ticker: event.series_ticker ?? null,
      title: m.title ?? m.yes_sub_title ?? null,
      status: m.status ?? null,
      yes_bid: m.yes_bid, yes_ask: m.yes_ask,
      no_bid: m.no_bid, no_ask: m.no_ask,
      last_price: m.last_price,
      volume: m.volume, open_interest: m.open_interest, liquidity: m.liquidity,
      close_time: m.close_time,
    }))
  );
}

/** Chunked insert — a single 10k-row insert will blow the statement limit. */
async function insertAll(db: SupabaseClient, table: string, rows: unknown[], size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`insert ${table}: ${error.message}`);
  }
}

/**
 * Settle any open position whose markets have all resolved.
 *
 * Settlement is looked up by ticker, not inferred from the open-events listing.
 * Absence from that listing is NOT evidence of a NO result — settled markets are
 * filtered out of it by definition — so treating "missing" as "lost" would book
 * a full loss on every basket that ever settles.
 */
async function settleOpenPositions(db: SupabaseClient, now: string): Promise<number> {
  const { data: open, error } = await db
    .from("paper_positions")
    .select("id, legs, cost_cents, fee_cents, locked_pnl_cents, confidence")
    .eq("status", "open");
  if (error) throw new Error(`select paper_positions: ${error.message}`);
  if (!open?.length) return 0;

  const tickers = [
    ...new Set(open.flatMap((p) => (p.legs as Array<{ ticker: string }>).map((l) => l.ticker))),
  ];
  const results = new Map<string, string>();
  for (const m of await fetchMarketsByTickers(tickers)) {
    if (m.result === "yes" || m.result === "no") results.set(m.ticker, m.result);
  }
  const settledYes = new Set([...results].filter(([, r]) => r === "yes").map(([t]) => t));

  let settled = 0;
  for (const pos of open) {
    const legs = pos.legs as Array<{ ticker: string }>;
    // Any leg without a definitive result leaves the whole basket open.
    if (legs.some((l) => !results.has(l.ticker))) continue;

    const { payout_cents, realized_pnl_cents } = settlePosition(pos, settledYes);
    const result = settleResult(realized_pnl_cents);
    const existing = typeof pos.confidence === "number" ? pos.confidence : null;
    const confidence = existing ?? confidenceFromEdge(
      Number(pos.locked_pnl_cents) || realized_pnl_cents,
      Number(pos.fee_cents) || 0,
    );
    const { error: upErr } = await db
      .from("paper_positions")
      .update({
        status: "settled",
        settled_ts: now,
        payout_cents,
        realized_pnl_cents,
        result,
        confidence,
      })
      .eq("id", pos.id);
    if (upErr) throw new Error(`settle position ${pos.id}: ${upErr.message}`);
    settled++;
  }
  return settled;
}

/**
 * Open a position per new basket.
 *
 * Relies on the client_key unique index rather than a read-then-write: with
 * ignoreDuplicates the insert is idempotent, so a re-run or an overlapping cron
 * firing can't double-open. Returns how many rows were actually new.
 */
async function openPaperPositions(
  db: SupabaseClient,
  opportunities: PricedOpportunity[],
  now: string,
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  if (!opportunities.length) return ids;

  const rows = opportunities.map((o) => ({
    client_key: clientKey(o),
    opened_ts: now,
    event_ticker: o.eventTicker,
    series_ticker: o.seriesTicker,
    title: o.title,
    kind: o.kind,
    // price_cents / fee_type / fee_multiplier live in legs jsonb (no those columns here)
    legs: o.legs,
    contracts: DEMO_LOT,
    cost_cents: o.costCents,
    fee_cents: o.feeCents,
    guaranteed_payout_cents: o.guaranteedPayoutCents,
    locked_pnl_cents: o.netEdgeCents,
    status: "open",
    result: "open",
    confidence: o.confidence,
    close_time: o.closeTime,
  }));

  const { data, error } = await db
    .from("paper_positions")
    .upsert(rows, { onConflict: "client_key", ignoreDuplicates: true })
    .select("id, client_key");
  if (error) throw new Error(`insert paper_positions: ${error.message}`);
  for (const row of data ?? []) {
    ids.set(row.client_key as string, row.id as number);
  }
  return ids;
}

/** Equity = starting bankroll + realised P&L. Unsettled baskets are not marked to market. */
async function writeEquityPoint(db: SupabaseClient, ts: string) {
  const { data, error } = await db
    .from("paper_positions")
    .select("realized_pnl_cents")
    .eq("status", "settled");
  if (error) throw new Error(`select realised pnl: ${error.message}`);

  const realised = (data ?? []).reduce((s, r) => s + (r.realized_pnl_cents ?? 0), 0);
  const { error: insErr } = await db.from("portfolio_snapshots").insert({
    ts,
    account_value: (PAPER_STARTING_BANKROLL_CENTS + realised) / 100,
    paper: true,
  });
  if (insErr) {
    const msg = insErr.message ?? '';
    if (/portfolio_snapshots|schema cache|does not exist/i.test(msg)) {
      console.warn(`skip equity point: ${msg}`);
      return;
    }
    throw new Error(`insert portfolio_snapshots: ${msg}`);
  }
}

async function run(): Promise<Response> {
  const started = Date.now();
  const nowIso = new Date().toISOString();
  const cfg = config();

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: runRow, error: runErr } = await db
    .from("scan_runs").insert({ ts: nowIso }).select("id").single();
  if (runErr) throw new Error(`insert scan_runs: ${runErr.message}`);
  const runId = runRow.id as number;

  try {
    const events = await fetchOpenEvents();
    const rows = snapshotRows(runId, events, nowIso);
    await insertAll(db, "market_snapshots", rows);

    const detected = events.flatMap((e) => scanEvent(e, cfg));
    const priced = await priceAllOpportunities(db, detected);
    const takeable = priced.filter((o) => o.netEdgeCents >= cfg.minNetEdgeCents);
    const openedIds = await openPaperPositions(db, takeable, nowIso);
    await insertOpportunities(
      db,
      priced.map((o) => {
        const paperId = openedIds.get(clientKey(o));
        if (paperId != null) {
          return opportunityRow({
            opp: o,
            runId,
            decision: "taken",
            reason: "paper 1 lot",
            paperPositionId: paperId,
          });
        }
        return opportunityRow({
          opp: o,
          runId,
          decision: "skipped",
          reason: o.netEdgeCents < cfg.minNetEdgeCents
            ? "below min net edge after fees"
            : "already open",
        });
      }),
    );
    const opened = openedIds.size;
    const opportunities = takeable;
    const settled = await settleOpenPositions(db, nowIso);
    await writeEquityPoint(db, nowIso);

    // Keys match scan_runs columns exactly so the same object serves as the
    // update payload and the HTTP response body.
    const summary = {
      events: events.length,
      markets: rows.length,
      opportunities: opportunities.length,
      positions_opened: opened,
      positions_settled: settled,
      duration_ms: Date.now() - started,
      ok: true,
    };
    await db.from("scan_runs").update(summary).eq("id", runId);
    const trade = await invokeTradeOnce();
    return Response.json({ run_id: runId, ...summary, trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("scan_runs")
      .update({ ok: false, error: message, duration_ms: Date.now() - started })
      .eq("id", runId);
    const trade = await invokeTradeOnce();
    return Response.json({ ok: false, run_id: runId, error: message, trade }, { status: 500 });
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
