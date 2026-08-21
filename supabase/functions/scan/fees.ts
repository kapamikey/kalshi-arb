/**
 * Kalshi trading fee math.
 *
 * Kalshi's published formula is:
 *
 *     fee = ceil( rate * C * P * (1 - P) )        [in dollars]
 *
 * where C is contract count and P is the price in DOLLARS (0..1). The result is
 * rounded UP to the next whole cent. The general rate is 0.07; a handful of
 * series use 0.035. Fees are charged on the way IN only — settlement is free —
 * but a position closed early pays the fee again on the exit trade.
 *
 * Everything in this codebase is denominated in integer cents to avoid float
 * drift. Prices are 1..99 cents.
 */

export const DEFAULT_FEE_RATE = 0.07;

/**
 * Fee in whole cents for buying `contracts` at `priceCents`.
 *
 * Note the P*(1-P) term: fees peak at 50c (1.75c/contract at the 0.07 rate) and
 * approach zero at the tails. This is what makes deep-tail "arbs" look far more
 * profitable than they are once you account for the spread you cross.
 */
export function feeCents(
  contracts: number,
  priceCents: number,
  rate: number = DEFAULT_FEE_RATE,
): number {
  if (contracts <= 0) return 0;

  // Done in integers on purpose. The obvious float form
  //     Math.ceil(0.07 * 100 * 0.5 * 0.5 * 100)
  // evaluates to 175.00000000000003 and rounds UP to 176 — a fee that is one
  // cent too high on every round number, which is exactly the size of the edges
  // this scanner is trying to measure. Scaling the rate to basis points keeps
  // the whole numerator exact (max ~1.75e6 per contract, far inside 2^53), so
  // only the final division rounds, and it rounds where Kalshi rounds.
  const rateBps = Math.round(rate * 10_000);
  const numerator = rateBps * contracts * priceCents * (100 - priceCents);
  const denominator = 1_000_000;
  return Math.floor((numerator + denominator - 1) / denominator);
}

/** Total fee for a basket of legs, each charged independently. */
export function basketFeeCents(
  legs: ReadonlyArray<{ priceCents: number; contracts: number }>,
  rate: number = DEFAULT_FEE_RATE,
): number {
  return legs.reduce((sum, leg) => sum + feeCents(leg.contracts, leg.priceCents, rate), 0);
}
