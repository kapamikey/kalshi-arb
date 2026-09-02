/**
 * Candidate ledger writes for public.opportunities.
 * result is always null on insert (filled later). Confidence is 1–10 once scored,
 * or null when the book produced no candidate (empty skipped row).
 */

import type { PricedOpportunity } from "./fees.ts";

export type OpportunityDecision = "taken" | "skipped";

export type OpportunityRow = {
  run_id: number | null;
  event_ticker: string;
  tickers: string[];
  modeled_ev_cents: number;
  fee_cents: number;
  decision: OpportunityDecision;
  reason: string | null;
  confidence: number | null;
  result: null;
  demo_order_id: number | null;
  paper_position_id: number | null;
};

type InsertDb = {
  from(table: string): {
    insert(
      rows: OpportunityRow[],
    ): Promise<{ error: { message?: string } | null }>;
  };
};

export function opportunityRow(opts: {
  opp: PricedOpportunity;
  decision: OpportunityDecision;
  reason: string | null;
  runId?: number | null;
  paperPositionId?: number | null;
  demoOrderId?: number | null;
}): OpportunityRow {
  return {
    run_id: opts.runId ?? null,
    event_ticker: opts.opp.eventTicker,
    tickers: opts.opp.legs.map((l) => l.ticker),
    modeled_ev_cents: opts.opp.netEdgeCents,
    fee_cents: opts.opp.feeCents,
    decision: opts.decision,
    reason: opts.reason,
    confidence: opts.opp.confidence,
    result: null,
    demo_order_id: opts.demoOrderId ?? null,
    paper_position_id: opts.paperPositionId ?? null,
  };
}


/** Sentinel row when a run found no priced candidate. event_ticker is NOT NULL. */
export function emptyBookSkippedRow(opts: {
  runId?: number | null;
  events: number;
}): OpportunityRow {
  return {
    run_id: opts.runId ?? null,
    event_ticker: "_none",
    tickers: [],
    modeled_ev_cents: 0,
    fee_cents: 0,
    decision: "skipped",
    reason: `no +EV after fees (events=${opts.events})`,
    confidence: null,
    result: null,
    demo_order_id: null,
    paper_position_id: null,
  };
}

export async function insertOpportunities(db: InsertDb, rows: OpportunityRow[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await db.from("opportunities").insert(rows);
  if (error) throw new Error(`insert opportunities: ${error.message}`);
}
