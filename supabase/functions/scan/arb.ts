/**
 * Arbitrage detection over Kalshi order books.
 *
 * A NOTE ON WHAT IS AND ISN'T POSSIBLE, because it drives the whole design:
 *
 * Within a SINGLE market, "buy YES and buy NO" is never an arb. Kalshi derives
 * the NO book from the YES book: no_ask = 100 - yes_bid. So
 *
 *     yes_ask + no_ask = yes_ask + 100 - yes_bid = 100 + spread  >=  100
 *
 * always. You pay the spread, never collect it. Any scanner that only looks for
 * yes_ask + no_ask < 100 will find exactly nothing, forever. We still compute it
 * (`checkSingleMarket`) purely as an invariant assertion — if it ever fires we
 * want the row, because it means we misread the book, not that we found money.
 *
 * The real opportunity is ACROSS the outcomes of one mutually-exclusive event.
 * A game event has separate order books for "Team A wins" and "Team B wins",
 * quoted by different participants. Exactly one settles at 100c. So:
 *
 *   OVERROUND (buy every YES): if sum(yes_ask) < 100 - fees, buy one contract of
 *   each outcome. One pays 100c, the rest pay 0. Locked profit.
 *
 *   UNDERROUND (buy every NO): with n outcomes, exactly one NO loses and n-1 pay
 *   100c. If sum(no_ask) < (n-1)*100 - fees, the basket is locked profit.
 *
 * Both require the event to be genuinely mutually exclusive AND collectively
 * exhaustive. Kalshi flags this per event; we refuse to trade events that aren't
 * flagged, because a game with an unlisted draw outcome breaks the guarantee.
 */

import { basketFeeCents, DEFAULT_FEE_RATE } from "./fees.ts";
import type { KalshiEvent, KalshiMarket } from "./kalshi.ts";

export type ArbKind = "overround" | "underround" | "single_market";

export interface ArbLeg {
  ticker: string;
  side: "yes" | "no";
  priceCents: number;
  contracts: number;
  /** Resting size at that price, if the book gave us one. */
  availableContracts: number | null;
}

export interface ArbOpportunity {
  eventTicker: string;
  seriesTicker: string;
  title: string;
  kind: ArbKind;
  legs: ArbLeg[];
  contracts: number;
  /** What the basket costs to put on, before fees. */
  costCents: number;
  /** What the basket is guaranteed to pay at settlement, worst case. */
  guaranteedPayoutCents: number;
  feeCents: number;
  /** guaranteedPayout - cost - fees. Positive means locked profit. */
  netEdgeCents: number;
  /** Net edge as a fraction of capital at risk. */
  edgeBps: number;
  closeTime: string | null;
}

export interface ScanConfig {
  feeRate: number;
  /** Minimum net profit in cents for the basket to be worth recording. */
  minNetEdgeCents: number;
  /** Hard cap on basket size regardless of displayed depth. */
  maxContracts: number;
  /** Skip markets whose book is thinner than this. */
  minVolume: number;
}

export const DEFAULT_SCAN_CONFIG: ScanConfig = {
  feeRate: DEFAULT_FEE_RATE,
  minNetEdgeCents: 1,
  maxContracts: 20,
  minVolume: 0,
};

/** A price of 0 means "no resting offer", not "free". Treat it as unavailable. */
function tradableAsk(ask: number | null | undefined): number | null {
  if (ask === null || ask === undefined) return null;
  if (ask <= 0 || ask >= 100) return null;
  return ask;
}

/**
 * How many contracts we can actually take, given displayed depth on every leg
 * and our own cap. Missing depth data falls back to the cap — Kalshi's market
 * list endpoint doesn't return level sizes, so this is usually the cap. That
 * makes recorded size optimistic; the paper ledger notes it as unverified.
 */
function sizeBasket(
  depths: Array<number | null>,
  maxContracts: number,
): { contracts: number; depthKnown: boolean } {
  const known = depths.filter((d): d is number => d !== null && d > 0);
  const depthKnown = known.length === depths.length && depths.length > 0;
  if (!depthKnown) return { contracts: maxContracts, depthKnown: false };
  return { contracts: Math.min(maxContracts, ...known), depthKnown: true };
}

function buildOpportunity(
  event: KalshiEvent,
  kind: ArbKind,
  legSpecs: Array<{ market: KalshiMarket; side: "yes" | "no"; priceCents: number }>,
  guaranteedPayoutPerBasket: number,
  cfg: ScanConfig,
): ArbOpportunity | null {
  const { contracts } = sizeBasket(
    legSpecs.map(() => null),
    cfg.maxContracts,
  );
  if (contracts <= 0) return null;

  const legs: ArbLeg[] = legSpecs.map((spec) => ({
    ticker: spec.market.ticker,
    side: spec.side,
    priceCents: spec.priceCents,
    contracts,
    availableContracts: null,
  }));

  const costCents = legs.reduce((s, l) => s + l.priceCents * l.contracts, 0);
  const fee = basketFeeCents(legs, cfg.feeRate);
  const guaranteedPayoutCents = guaranteedPayoutPerBasket * contracts;
  const netEdgeCents = guaranteedPayoutCents - costCents - fee;

  if (netEdgeCents < cfg.minNetEdgeCents) return null;

  return {
    eventTicker: event.event_ticker,
    seriesTicker: event.series_ticker ?? "",
    title: event.title ?? "",
    kind,
    legs,
    contracts,
    costCents,
    guaranteedPayoutCents,
    feeCents: fee,
    netEdgeCents,
    edgeBps: costCents > 0 ? Math.round((netEdgeCents / costCents) * 10000) : 0,
    closeTime: legSpecs[0]?.market.close_time ?? null,
  };
}

/** Invariant check — see the module header. Should never produce a hit. */
export function checkSingleMarket(
  event: KalshiEvent,
  market: KalshiMarket,
  cfg: ScanConfig,
): ArbOpportunity | null {
  const yesAsk = tradableAsk(market.yes_ask);
  const noAsk = tradableAsk(market.no_ask);
  if (yesAsk === null || noAsk === null) return null;
  if (yesAsk + noAsk >= 100) return null;

  return buildOpportunity(
    event,
    "single_market",
    [
      { market, side: "yes", priceCents: yesAsk },
      { market, side: "no", priceCents: noAsk },
    ],
    100,
    cfg,
  );
}

/** Buy YES on every outcome: costs sum(yes_ask), pays exactly 100c. */
export function checkOverround(
  event: KalshiEvent,
  markets: KalshiMarket[],
  cfg: ScanConfig,
): ArbOpportunity | null {
  if (markets.length < 2) return null;
  const specs: Array<{ market: KalshiMarket; side: "yes"; priceCents: number }> = [];
  for (const market of markets) {
    const ask = tradableAsk(market.yes_ask);
    if (ask === null) return null; // one unquotable leg breaks the guarantee
    specs.push({ market, side: "yes", priceCents: ask });
  }
  const total = specs.reduce((s, spec) => s + spec.priceCents, 0);
  if (total >= 100) return null;
  return buildOpportunity(event, "overround", specs, 100, cfg);
}

/** Buy NO on every outcome: n-1 of them pay 100c. */
export function checkUnderround(
  event: KalshiEvent,
  markets: KalshiMarket[],
  cfg: ScanConfig,
): ArbOpportunity | null {
  const n = markets.length;
  if (n < 2) return null;
  const specs: Array<{ market: KalshiMarket; side: "no"; priceCents: number }> = [];
  for (const market of markets) {
    const ask = tradableAsk(market.no_ask);
    if (ask === null) return null;
    specs.push({ market, side: "no", priceCents: ask });
  }
  const total = specs.reduce((s, spec) => s + spec.priceCents, 0);
  const payout = (n - 1) * 100;
  if (total >= payout) return null;
  return buildOpportunity(event, "underround", specs, payout, cfg);
}

/**
 * All opportunities in one event.
 *
 * Overround and underround are mutually exclusive in practice (both firing would
 * mean the book is crossed with itself), but we return whatever is found and let
 * the caller rank by net edge.
 */
export function scanEvent(event: KalshiEvent, cfg: ScanConfig): ArbOpportunity[] {
  const markets = (event.markets ?? []).filter(
    (m) => m.status === "active" && (m.volume ?? 0) >= cfg.minVolume,
  );
  if (markets.length === 0) return [];

  const found: ArbOpportunity[] = [];

  for (const market of markets) {
    const hit = checkSingleMarket(event, market, cfg);
    if (hit) found.push(hit);
  }

  // Cross-outcome baskets are only guaranteed when the event partitions the
  // outcome space. Kalshi tells us; if it doesn't, we don't guess.
  if (event.mutually_exclusive === true && markets.length === (event.markets ?? []).length) {
    const over = checkOverround(event, markets, cfg);
    if (over) found.push(over);
    const under = checkUnderround(event, markets, cfg);
    if (under) found.push(under);
  }

  return found.sort((a, b) => b.netEdgeCents - a.netEdgeCents);
}
