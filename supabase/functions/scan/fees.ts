/**
 * CoS fee + score helpers for demo_orders and paper_positions writers.
 *
 * Live fee source of truth is public.kalshi_taker_fee_cents(contracts, price_cents,
 * fee_multiplier, fee_rate). Always call that RPC first. The arb.ts integer
 * formula is only a fallback when RPC fails; with fee_multiplier=1 it matches
 * ceil(rate * C * P$ * (1-P$)) in cents.
 */

import { DEFAULT_FEE_RATE, feeCents, type ArbOpportunity } from "./arb.ts";
import { fetchSeriesFee, type SeriesFee } from "./kalshi.ts";

/** Duck type so Node tests can import this file without the jsr: specifier. */
export type FeeRpc = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message?: string } | null }>;
};

export const DEMO_LOT = 1;

export type CosResult = "win" | "loss" | "open" | "flat" | "rejected";

export type FeeQuote = SeriesFee & { fee_cents: number };

/**
 * Map locked (or expected) P&L vs fees onto 1–10.
 *
 *  1  non-positive edge after fees
 *  2  edge < 25% of fees
 *  3  25–50% of fees
 *  4  50–75%
 *  5  75–100% (barely covers another fee tick)
 *  6  1–1.5× fees
 *  7  1.5–2×
 *  8  2–3×
 *  9  3–5×
 * 10  ≥5× fees, or fees are 0 with a positive edge
 *
 * Null only before a score exists. Once edge is known, always return 1–10.
 */
export function confidenceFromEdge(lockedPnlCents: number, feeCentsTotal: number): number {
  if (!(feeCentsTotal > 0)) return lockedPnlCents > 0 ? 10 : 1;
  const r = lockedPnlCents / feeCentsTotal;
  if (r <= 0) return 1;
  if (r < 0.25) return 2;
  if (r < 0.5) return 3;
  if (r < 0.75) return 4;
  if (r < 1) return 5;
  if (r < 1.5) return 6;
  if (r < 2) return 7;
  if (r < 3) return 8;
  if (r < 5) return 9;
  return 10;
}

export function settleResult(realizedPnlCents: number): "win" | "loss" | "flat" {
  if (realizedPnlCents > 0) return "win";
  if (realizedPnlCents < 0) return "loss";
  return "flat";
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Taker fee in cents. RPC first; arb.ts feeCents only if the RPC errors or
 * returns a non-integer. fee_multiplier scales the same integer numerator
 * (matches multiplier=1 tests).
 */
export async function kalshiTakerFeeCents(
  db: FeeRpc,
  args: {
    contracts: number;
    price_cents: number;
    fee_multiplier: number;
    fee_rate?: number;
  },
): Promise<number> {
  const contracts = args.contracts;
  const price_cents = args.price_cents;
  const fee_multiplier = args.fee_multiplier;
  const fee_rate = args.fee_rate ?? DEFAULT_FEE_RATE;

  const { data, error } = await db.rpc("kalshi_taker_fee_cents", {
    contracts,
    price_cents,
    fee_multiplier,
    fee_rate,
  });
  if (!error) {
    const n = asInt(data);
    if (n !== null) return n;
  }

  if (contracts <= 0) return 0;
  const numerator =
    Math.round(fee_rate * 10_000) * fee_multiplier * contracts * price_cents * (100 - price_cents);
  if (fee_multiplier === 1) return feeCents(contracts, price_cents, fee_rate);
  return Math.floor((numerator + 999_999) / 1_000_000);
}

export type PricedLeg = {
  ticker: string;
  side: string;
  priceCents: number;
  contracts: number;
  fee_cents: number;
  fee_type: string;
  fee_multiplier: number;
};

export type PricedOpportunity = ArbOpportunity & {
  legs: PricedLeg[];
  feeType: string;
  feeMultiplier: number;
  confidence: number;
};

export async function priceOpportunity(
  db: FeeRpc,
  opp: ArbOpportunity,
  seriesFee?: SeriesFee,
): Promise<PricedOpportunity> {
  const fee = seriesFee ?? (await fetchSeriesFee(opp.seriesTicker));
  const legs: PricedLeg[] = [];
  let feeTotal = 0;
  for (const leg of opp.legs) {
    const fee_cents = await kalshiTakerFeeCents(db, {
      contracts: DEMO_LOT,
      price_cents: leg.priceCents,
      fee_multiplier: fee.fee_multiplier,
      fee_rate: DEFAULT_FEE_RATE,
    });
    feeTotal += fee_cents;
    legs.push({
      ticker: leg.ticker,
      side: leg.side,
      priceCents: leg.priceCents,
      contracts: DEMO_LOT,
      fee_cents,
      fee_type: fee.fee_type,
      fee_multiplier: fee.fee_multiplier,
    });
  }

  const costCents = legs.reduce((s, l) => s + l.priceCents * l.contracts, 0);
  const n = legs.length;
  const payoutPerBasket = (opp.kind === "overround" ? 1 : Math.max(1, n - 1)) * 100;
  const guaranteedPayoutCents = payoutPerBasket * DEMO_LOT;
  const netEdgeCents = guaranteedPayoutCents - costCents - feeTotal;

  return {
    ...opp,
    legs,
    contracts: DEMO_LOT,
    costCents,
    guaranteedPayoutCents,
    feeCents: feeTotal,
    netEdgeCents,
    feeType: fee.fee_type,
    feeMultiplier: fee.fee_multiplier,
    confidence: confidenceFromEdge(netEdgeCents, feeTotal),
  };
}

export async function priceOpportunities(
  db: FeeRpc,
  opps: ArbOpportunity[],
  minNetEdgeCents: number,
): Promise<PricedOpportunity[]> {
  const seriesCache = new Map<string, SeriesFee>();
  const out: PricedOpportunity[] = [];
  for (const opp of opps) {
    const key = opp.seriesTicker || "";
    let fee = seriesCache.get(key);
    if (!fee) {
      fee = await fetchSeriesFee(key);
      seriesCache.set(key, fee);
    }
    const priced = await priceOpportunity(db, opp, fee);
    if (priced.netEdgeCents >= minNetEdgeCents) out.push(priced);
  }
  return out;
}
