/**
 * Paper trading ledger.
 *
 * The engine is deliberately pessimistic, because the failure mode of a paper
 * arb book is flattering itself:
 *
 *  - Every leg fills by CROSSING the spread (we pay the ask, never the mid and
 *    never the bid). Assuming mid fills is the single biggest way paper arb
 *    results diverge from live ones.
 *  - Fees are charged on entry for every leg.
 *  - A basket is only opened if ALL legs are quotable at the same instant. Real
 *    execution risk — one leg fills, the other moves — is not modelled here and
 *    is tracked separately as `leg_risk_note`, because a scanner cannot observe
 *    it. Treat locked P&L as an upper bound.
 *  - Displayed depth is usually unknown from the markets endpoint, so basket
 *    size is capped by config rather than by the book. Size is flagged
 *    `depth_verified = false` so backtests can discount it.
 *
 * Once a genuine arb basket is on, its P&L is determined at entry: exactly one
 * outcome pays. Settlement therefore does not depend on which team won, which is
 * the entire point. We still reconcile against observed settlement so that a
 * mistaken "arb" (a non-exhaustive event, a voided market) shows up as a loss
 * instead of silently booking its theoretical profit.
 */

import type { ArbOpportunity } from "./arb.ts";

export interface PaperPosition {
  client_key: string;
  event_ticker: string;
  series_ticker: string;
  title: string;
  kind: string;
  legs: unknown;
  contracts: number;
  cost_cents: number;
  fee_cents: number;
  guaranteed_payout_cents: number;
  locked_pnl_cents: number;
  edge_bps: number;
  depth_verified: boolean;
  status: string;
  close_time: string | null;
  opened_ts: string;
}

/**
 * Stable identity for a basket so repeated scans don't re-open the same trade.
 *
 * Keyed on event + kind + the leg prices, so a basket at a genuinely new price
 * counts as a new opportunity but an unchanged book scanned every 5 minutes does
 * not. Without the price component the scanner would open one position per event
 * and then go blind to real re-quotes; with it, a flickering book can still
 * produce near-duplicates, which the per-event open-position cap bounds.
 */
export function clientKey(opp: ArbOpportunity): string {
  const legs = opp.legs
    .map((l) => `${l.ticker}:${l.side}:${l.priceCents}`)
    .sort()
    .join("|");
  return `${opp.eventTicker}#${opp.kind}#${legs}`;
}

export function toPaperPosition(opp: ArbOpportunity, now: Date): PaperPosition {
  return {
    client_key: clientKey(opp),
    event_ticker: opp.eventTicker,
    series_ticker: opp.seriesTicker,
    title: opp.title,
    kind: opp.kind,
    legs: opp.legs,
    contracts: opp.contracts,
    cost_cents: opp.costCents,
    fee_cents: opp.feeCents,
    guaranteed_payout_cents: opp.guaranteedPayoutCents,
    locked_pnl_cents: opp.netEdgeCents,
    edge_bps: opp.edgeBps,
    depth_verified: opp.legs.every((l) => l.availableContracts !== null),
    status: "open",
    close_time: opp.closeTime,
    opened_ts: now.toISOString(),
  };
}

/**
 * Realised P&L for a settled basket, given which tickers settled YES.
 *
 * `settledYes` is the set of tickers that resolved to YES. Payout is computed
 * from what actually happened rather than from the theoretical guarantee, so a
 * broken assumption surfaces as a real loss in the equity curve.
 */
export function settlePosition(
  position: Pick<PaperPosition, "legs" | "cost_cents" | "fee_cents">,
  settledYes: ReadonlySet<string>,
): { payout_cents: number; realized_pnl_cents: number } {
  const legs = position.legs as Array<{ ticker: string; side: string; contracts: number }>;
  let payout = 0;
  for (const leg of legs) {
    const wonYes = settledYes.has(leg.ticker);
    const legWins = leg.side === "yes" ? wonYes : !wonYes;
    if (legWins) payout += 100 * leg.contracts;
  }
  return {
    payout_cents: payout,
    realized_pnl_cents: payout - position.cost_cents - position.fee_cents,
  };
}
