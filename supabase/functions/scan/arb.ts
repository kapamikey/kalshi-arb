/**
 * Fee math and arbitrage detection.
 *
 * WHAT IS AND ISN'T POSSIBLE, because it drives the design:
 *
 * Within a SINGLE market, "buy YES and buy NO" is never an arb. Kalshi derives
 * the NO book from the YES book (no_ask = 100 - yes_bid), so
 *
 *     yes_ask + no_ask = yes_ask + 100 - yes_bid = 100 + spread  >=  100
 *
 * always. You pay the spread, never collect it. There is no code here for that
 * case because it cannot fire.
 *
 * The real opportunity is ACROSS the outcomes of one mutually-exclusive event,
 * where separate order books are quoted by different participants. Exactly one
 * outcome settles at 100c, so:
 *
 *   YES basket (overround):  sum(yes_ask) < 100          -> 1 leg pays 100c
 *   NO  basket (underround): sum(no_ask)  < (n-1)*100    -> n-1 legs pay 100c
 *
 * Both require the event to be mutually exclusive AND collectively exhaustive.
 * Kalshi flags this per event; we refuse unflagged events, because a game with
 * an unlisted draw outcome breaks the guarantee.
 */

import type { KalshiEvent, KalshiMarket } from "./kalshi.ts";

export const DEFAULT_FEE_RATE = 0.07;

/**
 * Kalshi's published fee: ceil(rate * C * P * (1-P)) in dollars, P in dollars.
 *
 * Computed in integers on purpose. The obvious float form
 *     Math.ceil(0.07 * 100 * 0.5 * 0.5 * 100)
 * evaluates to 175.00000000000003 and rounds UP to 176 — one cent too high on
 * every round number, which is the same order of magnitude as the edges being
 * measured. Scaling the rate to basis points keeps the numerator exact, so only
 * the final division rounds, and it rounds where Kalshi rounds.
 */
export function feeCents(
  contracts: number,
  priceCents: number,
  rate: number = DEFAULT_FEE_RATE,
): number {
  if (contracts <= 0) return 0;
  const numerator = Math.round(rate * 10_000) * contracts * priceCents * (100 - priceCents);
  return Math.floor((numerator + 999_999) / 1_000_000);
}

export type ArbSide = "yes" | "no";

export interface ArbLeg {
  ticker: string;
  side: ArbSide;
  priceCents: number;
  contracts: number;
}

export interface ArbOpportunity {
  eventTicker: string;
  seriesTicker: string;
  title: string;
  /** "overround" = YES basket, "underround" = NO basket. */
  kind: "overround" | "underround";
  legs: ArbLeg[];
  contracts: number;
  costCents: number;
  /** Worst-case settlement value of the basket. */
  guaranteedPayoutCents: number;
  feeCents: number;
  /** guaranteedPayout - cost - fees. Positive means locked profit. */
  netEdgeCents: number;
  closeTime: string | null;
}

export interface ScanConfig {
  feeRate: number;
  /** Minimum net profit in cents for a basket to be worth recording. */
  minNetEdgeCents: number;
  /**
   * Basket size. A hard cap, not a book-derived number: Kalshi's markets
   * endpoint returns no level sizes, so real depth is unknown. Recorded size is
   * therefore optimistic — see the fill-risk note in the README.
   */
  contracts: number;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  feeRate: DEFAULT_FEE_RATE,
  minNetEdgeCents: 1,
  contracts: 20,
};

/** A price of 0 or 100 means "no resting offer", not a free contract. */
function tradableAsk(ask: number | null | undefined): number | null {
  if (ask === null || ask === undefined || ask <= 0 || ask >= 100) return null;
  return ask;
}

/**
 * Price one side of every outcome as a single basket.
 *
 * The two directions differ only in which ask they read and how many legs pay
 * out, so they share one implementation.
 */
export function checkBasket(
  event: KalshiEvent,
  markets: KalshiMarket[],
  side: ArbSide,
  cfg: ScanConfig,
): ArbOpportunity | null {
  const n = markets.length;
  if (n < 2) return null;

  const legs: ArbLeg[] = [];
  for (const market of markets) {
    const ask = tradableAsk(side === "yes" ? market.yes_ask : market.no_ask);
    if (ask === null) return null; // one unquotable leg breaks the guarantee
    legs.push({ ticker: market.ticker, side, priceCents: ask, contracts: cfg.contracts });
  }

  // A YES basket has exactly one winner; a NO basket has exactly n-1.
  const payoutPerBasket = (side === "yes" ? 1 : n - 1) * 100;

  const costCents = legs.reduce((s, l) => s + l.priceCents * l.contracts, 0);
  const fee = legs.reduce((s, l) => s + feeCents(l.contracts, l.priceCents, cfg.feeRate), 0);
  const guaranteedPayoutCents = payoutPerBasket * cfg.contracts;
  const netEdgeCents = guaranteedPayoutCents - costCents - fee;

  if (netEdgeCents < cfg.minNetEdgeCents) return null;

  return {
    eventTicker: event.event_ticker,
    seriesTicker: event.series_ticker ?? "",
    title: event.title ?? "",
    kind: side === "yes" ? "overround" : "underround",
    legs,
    contracts: cfg.contracts,
    costCents,
    guaranteedPayoutCents,
    feeCents: fee,
    netEdgeCents,
    closeTime: markets[0]?.close_time ?? null,
  };
}

/**
 * Opportunities in one event.
 *
 * At most one direction can fire on a well-formed book: a YES basket needs
 * sum(yes_ask) < 100 and a NO basket needs sum(yes_bid) > 100, and yes_bid <=
 * yes_ask makes those mutually exclusive. Both are checked anyway so a crossed
 * book surfaces rather than being silently half-read.
 */
export function scanEvent(event: KalshiEvent, cfg: ScanConfig): ArbOpportunity[] {
  const all = event.markets ?? [];
  const active = all.filter((m) => m.status === "active");

  // Cross-outcome baskets are only guaranteed when the markets partition the
  // outcome space. A filtered-out leg means they no longer do.
  if (!event.mutually_exclusive || active.length !== all.length || active.length < 2) return [];

  return (["yes", "no"] as const)
    .map((side) => checkBasket(event, active, side, cfg))
    .filter((o): o is ArbOpportunity => o !== null)
    .sort((a, b) => b.netEdgeCents - a.netEdgeCents);
}
