/**
 * Scheduled scanner entrypoint.
 *
 * One invocation:
 *   1. pulls every open event with nested markets from Kalshi (read-only),
 *   2. records a book snapshot for each sports market (the data-collection job),
 *   3. runs arb detection per event,
 *   4. opens paper positions for baskets that clear the edge threshold,
 *   5. settles paper positions whose markets have resolved,
 *   6. writes an equity point to portfolio_snapshots (paper = true).
 *
 * It never authenticates to Kalshi and never places an order.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { fetchMarketsByTickers, fetchOpenEvents, isSportsEvent, type KalshiEvent } from "./kalshi.ts";
import { DEFAULT_SCAN_CONFIG, scanEvent, type ArbOpportunity, type ScanConfig } from "./arb.ts";
import { clientKey, settlePosition, toPaperPosition } from "./paper.ts";

const PAPER_STARTING_BANKROLL_CENTS = 100_000; // $1,000, matching existing paper rows

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function config(): ScanConfig {
  return {
    ...DEFAULT_SCAN_CONFIG,
    minNetEdgeCents: envInt("MIN_NET_EDGE_CENTS", DEFAULT_SCAN_CONFIG.minNetEdgeCents),
    maxContracts: envInt("MAX_CONTRACTS", DEFAULT_SCAN_CONFIG.maxContracts),
    minVolume: envInt("MIN_VOLUME", DEFAULT_SCAN_CONFIG.minVolume),
  };
}

function snapshotRows(runId: number, events: KalshiEvent[], ts: string) {
  const rows = [];
  for (const event of events) {
    for (const m of event.markets ?? []) {
      rows.push({
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
      });
    }
  }
  return rows;
}

/** Chunked insert — a single 10k-row insert will blow the statement limit. */
async function insertAll(db: SupabaseClient, table: string, rows: unknown[], size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).insert(rows.slice(i, i + size));
    if (error) throw new Error(`insert ${table}: ${error.message}`);
  }
}

/**
 * Settle any open paper position whose markets have all resolved.
 *
 * Settlement is looked up by ticker rather than inferred from the open-events
 * listing. Absence from that listing is NOT evidence of a NO result — settled
 * markets are filtered out of it by definition — so treating "missing" as
 * "lost" would book a full loss on every basket that ever settles. A position
 * is only closed once every leg reports an explicit yes/no result.
 */
async function settleOpenPositions(db: SupabaseClient, now: string): Promise<number> {
  const { data: open, error } = await db
    .from("paper_positions")
    .select("id, legs, cost_cents, fee_cents, event_ticker")
    .eq("status", "open");
  if (error) throw new Error(`select paper_positions: ${error.message}`);
  if (!open?.length) return 0;

  const tickers = [
    ...new Set(open.flatMap((p) => (p.legs as Array<{ ticker: string }>).map((l) => l.ticker))),
  ];
  const markets = await fetchMarketsByTickers(tickers);

  const resultByTicker = new Map<string, string>();
  for (const m of markets) {
    if (m.result === "yes" || m.result === "no") resultByTicker.set(m.ticker, m.result);
  }
  const settledYes = new Set(
    [...resultByTicker].filter(([, r]) => r === "yes").map(([t]) => t),
  );

  let settled = 0;
  for (const pos of open) {
    const legs = pos.legs as Array<{ ticker: string }>;
    // Any leg without a definitive result leaves the whole basket open.
    if (legs.some((l) => !resultByTicker.has(l.ticker))) continue;

    const { payout_cents, realized_pnl_cents } = settlePosition(pos, settledYes);
    const { error: upErr } = await db
      .from("paper_positions")
      .update({ status: "settled", settled_ts: now, payout_cents, realized_pnl_cents })
      .eq("id", pos.id);
    if (upErr) throw new Error(`settle position ${pos.id}: ${upErr.message}`);
    settled++;
  }
  return settled;
}

async function openPaperPositions(
  db: SupabaseClient,
  opportunities: ArbOpportunity[],
  now: Date,
): Promise<number> {
  if (!opportunities.length) return 0;

  const keys = opportunities.map(clientKey);
  const { data: existing, error } = await db
    .from("paper_positions")
    .select("client_key")
    .in("client_key", keys);
  if (error) throw new Error(`select existing positions: ${error.message}`);

  const seen = new Set((existing ?? []).map((r) => r.client_key as string));
  const fresh = opportunities.filter((o) => !seen.has(clientKey(o)));
  if (!fresh.length) return 0;

  const rows = fresh.map((o) => toPaperPosition(o, now));
  // Ignore duplicates from a concurrent run rather than failing the batch.
  const { error: insErr } = await db
    .from("paper_positions")
    .upsert(rows, { onConflict: "client_key", ignoreDuplicates: true });
  if (insErr) throw new Error(`insert paper_positions: ${insErr.message}`);
  return rows.length;
}

async function writeEquityPoint(db: SupabaseClient, ts: string) {
  const { data, error } = await db
    .from("paper_performance")
    .select("realized_pnl_cents, unrealized_locked_cents")
    .single();
  if (error) throw new Error(`select paper_performance: ${error.message}`);

  const equityCents = PAPER_STARTING_BANKROLL_CENTS + (data?.realized_pnl_cents ?? 0);
  const { error: insErr } = await db
    .from("portfolio_snapshots")
    .insert({ ts, account_value: equityCents / 100, paper: true });
  if (insErr) throw new Error(`insert portfolio_snapshots: ${insErr.message}`);
}

async function run(): Promise<Response> {
  const started = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
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
    const sports = events.filter(isSportsEvent);
    const marketCount = sports.reduce((n, e) => n + (e.markets?.length ?? 0), 0);

    await insertAll(db, "market_snapshots", snapshotRows(runId, sports, nowIso));

    const opportunities = sports.flatMap((e) => scanEvent(e, cfg));

    if (opportunities.length) {
      await insertAll(db, "arb_opportunities", opportunities.map((o) => ({
        run_id: runId, ts: nowIso,
        event_ticker: o.eventTicker, series_ticker: o.seriesTicker, title: o.title,
        kind: o.kind, legs: o.legs, contracts: o.contracts,
        cost_cents: o.costCents, guaranteed_payout_cents: o.guaranteedPayoutCents,
        fee_cents: o.feeCents, net_edge_cents: o.netEdgeCents, edge_bps: o.edgeBps,
        traded: true, close_time: o.closeTime,
      })));
    }

    const opened = await openPaperPositions(db, opportunities, now);
    await settleOpenPositions(db, nowIso);
    await writeEquityPoint(db, nowIso);

    await db.from("scan_runs").update({
      events_scanned: events.length,
      sports_events: sports.length,
      markets_scanned: marketCount,
      opportunities: opportunities.length,
      positions_opened: opened,
      duration_ms: Date.now() - started,
      ok: true,
    }).eq("id", runId);

    return Response.json({
      ok: true, run_id: runId,
      events: events.length, sports_events: sports.length, markets: marketCount,
      opportunities: opportunities.length, positions_opened: opened,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("scan_runs").update({
      ok: false, error: message, duration_ms: Date.now() - started,
    }).eq("id", runId);
    return Response.json({ ok: false, run_id: runId, error: message }, { status: 500 });
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
