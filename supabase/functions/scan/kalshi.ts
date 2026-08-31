/**
 * Read-only Kalshi market data client.
 *
 * Deliberately has no credentials, no signing, and no POST. Every endpoint here
 * is public market data. There is no code path in this repository that can place
 * an order against a real account — adding one is a conscious, separate change.
 *
 * Nested markets currently quote as `*_dollars` strings (e.g. "0.45") rather
 * than integer-cent fields. Everything downstream — snapshots, arb math, the
 * dashboard — expects integer cents, so the fetch path normalizes on the way in.
 */

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  yes_sub_title?: string;
  status: string;
  /** Integer cents after normalizeMarket. */
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
  /** Current Kalshi payload; stripped into the integer-cent fields above. */
  yes_bid_dollars?: string | null;
  yes_ask_dollars?: string | null;
  no_bid_dollars?: string | null;
  no_ask_dollars?: string | null;
  last_price_dollars?: string | null;
  volume_fp?: string | null;
  open_interest_fp?: string | null;
  liquidity_dollars?: string | null;
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

/**
 * Dollar string ("0.4500") or dollar number → integer cents.
 * Empty / unparseable → null. Legacy integer-cent numbers are handled by asCents.
 */
export function centsFromDollars(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }
  return null;
}

/** Prefer a legacy integer-cent field; otherwise parse the `*_dollars` string. */
export function asCents(legacy: unknown, dollars: unknown): number | null {
  if (typeof legacy === "number" && Number.isFinite(legacy)) return Math.round(legacy);
  return centsFromDollars(dollars);
}

/** Contract counts (`volume_fp`, `open_interest_fp`) rounded to integers. */
export function asCount(legacy: unknown, fp: unknown): number | null {
  if (typeof legacy === "number" && Number.isFinite(legacy)) return Math.round(legacy);
  if (fp === null || fp === undefined || fp === "") return null;
  if (typeof fp === "number") {
    if (!Number.isFinite(fp)) return null;
    return Math.round(fp);
  }
  if (typeof fp === "string") {
    const n = Number.parseFloat(fp);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  }
  return null;
}

/** Map a raw Kalshi market onto integer-cent / integer-count fields. */
export function normalizeMarket(raw: KalshiMarket): KalshiMarket {
  return {
    ...raw,
    yes_bid: asCents(raw.yes_bid, raw.yes_bid_dollars),
    yes_ask: asCents(raw.yes_ask, raw.yes_ask_dollars),
    no_bid: asCents(raw.no_bid, raw.no_bid_dollars),
    no_ask: asCents(raw.no_ask, raw.no_ask_dollars),
    last_price: asCents(raw.last_price, raw.last_price_dollars),
    volume: asCount(raw.volume, raw.volume_fp),
    open_interest: asCount(raw.open_interest, raw.open_interest_fp),
    liquidity: asCents(raw.liquidity, raw.liquidity_dollars),
  };
}

function normalizeEvent(event: KalshiEvent): KalshiEvent {
  if (!event.markets) return event;
  return { ...event, markets: event.markets.map(normalizeMarket) };
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
    events.push(...(body.events ?? []).map(normalizeEvent));

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
      out.push(...(body.markets ?? []).map(normalizeMarket));
      if (!body.cursor || body.cursor === cursor) break;
      cursor = body.cursor;
    }
  }

  return out;
}
