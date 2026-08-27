/**
 * Paper ledger identity and settlement.
 *
 * The engine is deliberately pessimistic: every leg fills by CROSSING the spread
 * (we pay the ask, never the mid), and fees are charged on entry for every leg.
 * Execution risk — one leg fills, the other moves — is NOT modelled, because a
 * scanner cannot observe it. Locked P&L is an upper bound.
 */

import type { ArbOpportunity } from "./arb.ts";

/**
 * Stable identity for a basket so repeated scans don't re-open the same trade.
 *
 * Keyed on event + kind + leg prices. Without the price component the scanner
 * would open one position per event and then go blind to genuine re-quotes;
 * with it, an unchanged book scanned every 5 minutes stays a single position.
 */
export function clientKey(opp: ArbOpportunity): string {
  const legs = opp.legs
    .map((l) => `${l.ticker}:${l.side}:${l.priceCents}`)
    .sort()
    .join("|");
  return `${opp.eventTicker}#${opp.kind}#${legs}`;
}

/**
 * Realised P&L for a settled basket, given which tickers resolved YES.
 *
 * Computed from what actually happened rather than from the theoretical
 * guarantee, so a broken assumption (a non-exhaustive event, a voided market)
 * surfaces as a real loss in the equity curve instead of silently booking its
 * expected profit.
 */
export function settlePosition(
  position: { legs: unknown; cost_cents: number; fee_cents: number },
  settledYes: ReadonlySet<string>,
): { payout_cents: number; realized_pnl_cents: number } {
  const legs = position.legs as Array<{ ticker: string; side: string; contracts: number }>;
  let payout = 0;
  for (const leg of legs) {
    const wonYes = settledYes.has(leg.ticker);
    if (leg.side === "yes" ? wonYes : !wonYes) payout += 100 * leg.contracts;
  }
  return {
    payout_cents: payout,
    realized_pnl_cents: payout - position.cost_cents - position.fee_cents,
  };
}
