/**
 * Production-book ticket scoring. Demo books are never inputs.
 *
 * Reuses arb.ts feeCents/checkBasket. Conservative is 1 lot at ask+1¢ when
 * displayed size ≥ 2; size 1 is unfilled (no open ticket).
 */

import {
  DEFAULT_FEE_RATE,
  checkBasket,
  type ArbOpportunity,
  type ScanConfig,
} from "../scan/arb.ts";
import type { DisplayedAsks, KalshiEvent, KalshiMarket, KalshiSeries } from "../scan/kalshi.ts";

export const TICKET_TTL_MS = 30_000;
export const TICKET_CONTRACTS = 1;
export const MIN_DISPLAYED_SIZE = 2;
export const CRON_POSTS_ORDERS = false;

export type TicketLeg = {
  ticker: string;
  side: "yes" | "no";
  ask_cents: number;
  displayed_size: number | null;
  label?: string;
};

export type TicketDraft = {
  event_ticker: string;
  title: string;
  kind: "overround" | "underround";
  legs: TicketLeg[];
  quoted_ts: string;
  fee_cents: number;
  net_edge_cents: number;
  optimistic_pnl_cents: number;
  conservative_pnl_cents: number | null;
  min_displayed_size: number | null;
  depth_known: boolean;
};

export function isQuoteExpired(quotedTs: string, nowMs = Date.now()): boolean {
  const t = new Date(quotedTs).getTime();
  if (!Number.isFinite(t)) return true;
  return nowMs - t > TICKET_TTL_MS;
}

export function seriesAllowed(
  series: KalshiSeries | null,
  seriesTicker: string,
): { ok: boolean; feeRate: number; reason?: string } {
  const ticker = (seriesTicker || series?.ticker || series?.series_ticker || "").toUpperCase();
  const feeType = (series?.fee_type ?? "quadratic").toLowerCase();
  const freq = (series?.frequency ?? "").toLowerCase();
  const cat = (series?.category ?? "").toLowerCase();

  if (ticker.includes("PERP") || freq.includes("perp") || cat.includes("perpetual")) {
    return { ok: false, feeRate: 0, reason: "perp" };
  }
  if (feeType.includes("flat")) {
    return { ok: false, feeRate: 0, reason: "flat" };
  }
  if (feeType && !feeType.includes("quadratic")) {
    return { ok: false, feeRate: 0, reason: "non-quadratic" };
  }
  const M = typeof series?.fee_multiplier === "number" ? series.fee_multiplier : 1;
  return { ok: true, feeRate: DEFAULT_FEE_RATE * M };
}

function overlayAsks(market: KalshiMarket, asks: DisplayedAsks): KalshiMarket {
  return {
    ...market,
    yes_ask: asks.yes_ask,
    no_ask: asks.no_ask,
  };
}

function walkAsks(market: KalshiMarket, side: "yes" | "no"): KalshiMarket {
  const field = side === "yes" ? "yes_ask" : "no_ask";
  const cur = market[field];
  if (cur == null) return { ...market, [field]: null };
  return { ...market, [field]: cur + 1 };
}

export function minDisplayedSize(legs: TicketLeg[]): number | null {
  const sizes = legs.map((l) => l.displayed_size);
  if (sizes.some((s) => s === null || s === undefined)) return null;
  return Math.min(...(sizes as number[]));
}

export function shouldWriteOpenTicket(draft: TicketDraft): boolean {
  if (!draft.depth_known) return false;
  if (draft.min_displayed_size === null || draft.min_displayed_size < MIN_DISPLAYED_SIZE) {
    return false;
  }
  if (draft.optimistic_pnl_cents <= 0 || draft.net_edge_cents <= 0) return false;
  if (draft.conservative_pnl_cents === null || draft.conservative_pnl_cents <= 0) return false;
  return true;
}

export function scoreEventTickets(
  event: KalshiEvent,
  books: Map<string, DisplayedAsks>,
  feeRate: number,
  quotedTs: string,
): TicketDraft[] {
  const all = event.markets ?? [];
  const active = all.filter((m) => (m.status ?? "active") === "active");
  if (!event.mutually_exclusive || active.length !== all.length || active.length < 2) {
    return [];
  }

  const overlaid: KalshiMarket[] = [];
  let depthKnown = true;
  const sizeByTicker = new Map<string, { yes: number | null; no: number | null }>();

  for (const m of active) {
    const book = books.get(m.ticker);
    if (!book || !book.depthKnown) {
      depthKnown = false;
      overlaid.push({ ...m, yes_ask: null, no_ask: null });
      sizeByTicker.set(m.ticker, { yes: null, no: null });
      continue;
    }
    overlaid.push(overlayAsks(m, book));
    sizeByTicker.set(m.ticker, { yes: book.yes_ask_size, no: book.no_ask_size });
  }

  const cfg: ScanConfig = {
    feeRate,
    minNetEdgeCents: 1,
    contracts: TICKET_CONTRACTS,
  };
  const ev = { ...event, markets: overlaid };
  const drafts: TicketDraft[] = [];

  for (const side of ["yes", "no"] as const) {
    const optimistic = checkBasket(ev, overlaid, side, cfg);
    const walked = overlaid.map((m) => walkAsks(m, side));
    const conservativeOpp = checkBasket({ ...ev, markets: walked }, walked, side, cfg);

    const sizes = overlaid.map((m) =>
      side === "yes" ? sizeByTicker.get(m.ticker)?.yes ?? null : sizeByTicker.get(m.ticker)?.no ?? null,
    );
    const anyMissing = !depthKnown || sizes.some((s) => s === null);
    const minSize = anyMissing ? null : Math.min(...(sizes as number[]));

    const legs: TicketLeg[] = overlaid.map((m, i) => ({
      ticker: m.ticker,
      side,
      ask_cents: (side === "yes" ? m.yes_ask : m.no_ask) ?? 0,
      displayed_size: sizes[i],
      label: m.yes_sub_title || m.title || m.ticker,
    }));

    // Size 1 = conservative unfilled. Missing depth = unknown, not a number.
    const conservative =
      minSize === null
        ? null
        : minSize < MIN_DISPLAYED_SIZE
        ? null
        : conservativeOpp
        ? conservativeOpp.netEdgeCents
        : null;

    const draft: TicketDraft = {
      event_ticker: event.event_ticker,
      title: event.title ?? "",
      kind: side === "yes" ? "overround" : "underround",
      legs,
      quoted_ts: quotedTs,
      fee_cents: optimistic?.feeCents ?? 0,
      net_edge_cents: optimistic?.netEdgeCents ?? 0,
      optimistic_pnl_cents: optimistic?.netEdgeCents ?? 0,
      conservative_pnl_cents: conservative,
      min_displayed_size: minSize,
      depth_known: !anyMissing,
    };

    if (shouldWriteOpenTicket(draft) && optimistic) {
      drafts.push({
        ...draft,
        fee_cents: optimistic.feeCents,
        net_edge_cents: optimistic.netEdgeCents,
        optimistic_pnl_cents: optimistic.netEdgeCents,
        title: optimistic.title || event.title || "",
      });
    }
  }

  return drafts.sort((a, b) => b.net_edge_cents - a.net_edge_cents);
}

export function opportunityFromDraft(draft: TicketDraft): ArbOpportunity {
  return {
    eventTicker: draft.event_ticker,
    seriesTicker: "",
    title: draft.title,
    kind: draft.kind,
    legs: draft.legs.map((l) => ({
      ticker: l.ticker,
      side: l.side,
      priceCents: l.ask_cents,
      contracts: TICKET_CONTRACTS,
    })),
    contracts: TICKET_CONTRACTS,
    costCents: draft.legs.reduce((s, l) => s + l.ask_cents * TICKET_CONTRACTS, 0),
    guaranteedPayoutCents: (draft.kind === "overround" ? 1 : draft.legs.length - 1) *
      100 *
      TICKET_CONTRACTS,
    feeCents: draft.fee_cents,
    netEdgeCents: draft.net_edge_cents,
    closeTime: null,
  };
}

export function kindEnglish(kind: string): string {
  if (kind === "underround") return "Buy every NO";
  return "Buy every YES";
}

export function legsLine(legs: TicketLeg[]): string {
  return legs
    .map((l) => {
      const side = l.side === "no" ? "NO" : "YES";
      const name = l.label && l.label !== l.ticker ? l.label : l.ticker;
      return `${side} ${name} @ ${l.ask_cents}¢`;
    })
    .join(" · ");
}

export function approveBlockedReason(
  ticket: {
    quoted_ts: string;
    depth_known?: boolean;
    min_displayed_size?: number | null;
    legs?: TicketLeg[];
    conservative_pnl_cents: number | null;
    optimistic_pnl_cents: number;
    net_edge_cents: number;
    status?: string;
  },
  nowMs = Date.now(),
): string | null {
  if (ticket.status && ticket.status !== "open") return `status ${ticket.status}`;
  if (isQuoteExpired(ticket.quoted_ts, nowMs)) return "stale";
  const min = ticket.min_displayed_size ?? minDisplayedSize(ticket.legs ?? []);
  const depth = ticket.depth_known ?? (min !== null);
  if (!depth || min === null) return "no depth";
  if (min < MIN_DISPLAYED_SIZE) return "size < 2";
  if (ticket.conservative_pnl_cents === null || ticket.conservative_pnl_cents <= 0) {
    return "conservative ≤ 0";
  }
  if (ticket.optimistic_pnl_cents <= 0 || ticket.net_edge_cents <= 0) {
    return "optimistic net ≤ 0";
  }
  return null;
}
