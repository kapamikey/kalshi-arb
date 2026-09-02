/**
 * Read-only Kalshi market data client.
 *
 * Deliberately has no credentials, no signing, and no POST. Every endpoint here
 * is public market data. There is no code path in this repository that can place
 * an order against a real account — adding one is a conscious, separate change.
 */

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  yes_sub_title?: string;
  status: string;
  yes_bid: number | null;
  yes_ask: number | null;
  no_bid: number | null;
  no_ask: number | null;
  last_price: number | null;
  volume: number | null;
  open_interest: number | null;
  liquidity: number | null;
  close_time: string | null;
  /** "" while trading; "yes" / "no" once settled. The authoritative outcome. */
  result?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive?: boolean;
  markets?: KalshiMarket[];
}

interface EventsResponse {
  events?: KalshiEvent[];
  cursor?: string;
}

export class KalshiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Kalshi API ${status}: ${body.slice(0, 200)}`);
    this.name = "KalshiError";
  }
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json", "User-Agent": "kalshi-arb-scanner/1.0" },
  });

  if (!res.ok) throw new KalshiError(res.status, await res.text());
  return await res.json() as T;
}

/**
 * Every open event with its nested markets, following the cursor.
 *
 * `with_nested_markets` is what makes cross-outcome detection possible in one
 * pass — it groups each event's outcome books together, which is exactly the
 * unit an overround/underround basket is defined over.
 */
export async function fetchOpenEvents(opts: {
  maxPages?: number;
  pageLimit?: number;
} = {}): Promise<KalshiEvent[]> {
  const maxPages = opts.maxPages ?? 20;
  const pageLimit = opts.pageLimit ?? 200;

  const events: KalshiEvent[] = [];
  let cursor = "";

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string> = {
      status: "open",
      with_nested_markets: "true",
      limit: String(pageLimit),
    };
    if (cursor) params.cursor = cursor;

    const body = await getJson<EventsResponse>("/events", params);
    events.push(...(body.events ?? []));

    if (!body.cursor || body.cursor === cursor) break;
    cursor = body.cursor;
  }

  return events;
}

/**
 * Look markets up by ticker, regardless of status.
 *
 * Needed for settlement: `fetchOpenEvents` filters to status=open, so a market
 * that has resolved is simply absent from it. Inferring "gone from the open
 * listing" as "settled NO" would book a total loss on every basket that ever
 * settles. This asks for the specific tickers and reads the `result` field.
 */
export async function fetchMarketsByTickers(tickers: string[]): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  const BATCH = 100;

  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    let cursor = "";

    // A batch can still paginate if the API caps the page below our batch size.
    for (let page = 0; page < 5; page++) {
      const params: Record<string, string> = {
        tickers: batch.join(","),
        limit: String(BATCH),
      };
      if (cursor) params.cursor = cursor;

      const body = await getJson<{ markets?: KalshiMarket[]; cursor?: string }>(
        "/markets",
        params,
      );
      out.push(...(body.markets ?? []));
      if (!body.cursor || body.cursor === cursor) break;
      cursor = body.cursor;
    }
  }

  return out;
}

export function dollarsToCents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1.0000001) return Math.round(n * 100);
  return Math.round(n);
}

export function sizeToNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export type OrderbookLevel = { priceCents: number; size: number };

export type DisplayedAsks = {
  yes_ask: number | null;
  yes_ask_size: number | null;
  no_ask: number | null;
  no_ask_size: number | null;
  depthKnown: boolean;
};

function levelsFrom(raw: unknown): OrderbookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: OrderbookLevel[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const price = dollarsToCents(row[0]);
    const size = sizeToNumber(row[1]);
    if (price === null || size === null || price <= 0 || price >= 100) continue;
    out.push({ priceCents: price, size });
  }
  return out;
}

/** Best bid = highest price. */
function bestBid(levels: OrderbookLevel[]): OrderbookLevel | null {
  let best: OrderbookLevel | null = null;
  for (const l of levels) {
    if (!best || l.priceCents > best.priceCents) best = l;
  }
  return best;
}

/**
 * Executable asks from a YES/NO bid book. Buying YES lifts the complement of
 * the best NO bid; buying NO lifts the complement of the best YES bid.
 */
export function displayedAsksFromOrderbook(book: {
  yes?: unknown;
  no?: unknown;
  yes_dollars?: unknown;
  no_dollars?: unknown;
}): DisplayedAsks {
  const yesBids = levelsFrom(book.yes_dollars ?? book.yes);
  const noBids = levelsFrom(book.no_dollars ?? book.no);
  const bestYes = bestBid(yesBids);
  const bestNo = bestBid(noBids);
  const yes_ask = bestNo ? 100 - bestNo.priceCents : null;
  const no_ask = bestYes ? 100 - bestYes.priceCents : null;
  const yesOk = yes_ask !== null && yes_ask > 0 && yes_ask < 100;
  const noOk = no_ask !== null && no_ask > 0 && no_ask < 100;
  return {
    yes_ask: yesOk ? yes_ask : null,
    yes_ask_size: yesOk && bestNo ? bestNo.size : null,
    no_ask: noOk ? no_ask : null,
    no_ask_size: noOk && bestYes ? bestYes.size : null,
    depthKnown: yesOk && noOk && bestNo !== null && bestYes !== null,
  };
}

export type KalshiSeries = {
  ticker?: string;
  series_ticker?: string;
  fee_type?: string;
  fee_multiplier?: number;
  category?: string;
  frequency?: string;
};

export async function fetchSeries(seriesTicker: string): Promise<KalshiSeries | null> {
  if (!seriesTicker) return null;
  try {
    const body = await getJson<{ series?: KalshiSeries }>(
      `/series/${encodeURIComponent(seriesTicker)}`,
      {},
    );
    return body.series ?? null;
  } catch {
    return null;
  }
}

export async function fetchOrderbook(ticker: string): Promise<DisplayedAsks> {
  const body = await getJson<{
    orderbook?: Record<string, unknown>;
    orderbook_fp?: Record<string, unknown>;
  }>(`/markets/${encodeURIComponent(ticker)}/orderbook`, {});
  const raw = body.orderbook_fp ?? body.orderbook ?? {};
  return displayedAsksFromOrderbook(raw);
}

/**
 * Open mutually-exclusive events from the public production data host.
 * Caps how many we keep so a 30s cron can also pull orderbooks.
 */
export async function fetchExclusiveOpenEvents(cap = 20): Promise<KalshiEvent[]> {
  const maxPages = 8;
  const pageLimit = 200;
  const events: KalshiEvent[] = [];
  let cursor = "";

  for (let page = 0; page < maxPages && events.length < cap; page++) {
    const params: Record<string, string> = {
      status: "open",
      with_nested_markets: "true",
      limit: String(pageLimit),
    };
    if (cursor) params.cursor = cursor;
    const body = await getJson<EventsResponse>("/events", params);
    for (const e of body.events ?? []) {
      const markets = e.markets ?? [];
      if (e.mutually_exclusive === true && markets.length >= 2) {
        events.push(e);
        if (events.length >= cap) break;
      }
    }
    if (!body.cursor || body.cursor === cursor) break;
    cursor = body.cursor;
  }

  return events.slice(0, cap);
}

export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
