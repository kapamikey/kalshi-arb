/**
 * Read-only Kalshi market data client.
 *
 * Deliberately has no credentials, no signing, and no POST. Every endpoint here
 * is public market data. There is no code path in this repository that can place
 * an order against a real account — adding one is a conscious, separate change.
 *
 * Quote fields: the 2026 trade-api payload no longer sends integer-cent
 * `yes_bid` / `yes_ask` / `no_bid` / `no_ask` / `last_price` / `volume`. Nested
 * markets on GET /events and GET /markets return `*_dollars` / `*_fp` strings
 * instead (`yes_bid_dollars: "0.4500"`, `volume_fp: "118109.87"`). We normalize
 * to integer cents / counts on fetch so snapshot rows and arb math keep using
 * the existing integer columns.
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
  /** Raw 2026 trade-api dollar strings; consumed by normalizeMarket. */
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  liquidity_dollars?: string;
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
 * Integer cents from the legacy integer field or the current `*_dollars` string.
 * `"0.45"` → 45. A missing/unparseable value is null, not 0 (0 means no bid).
 */
export function centsFrom(cents: unknown, dollars: unknown): number | null {
  if (typeof cents === "number" && Number.isFinite(cents)) return Math.round(cents);
  if (typeof cents === "string" && cents.trim() !== "") {
    const n = Number(cents);
    if (Number.isFinite(n)) {
      return cents.includes(".") ? Math.round(n * 100) : Math.round(n);
    }
  }
  if (typeof dollars === "number" && Number.isFinite(dollars)) return Math.round(dollars * 100);
  if (typeof dollars === "string" && dollars.trim() !== "") {
    const n = Number.parseFloat(dollars);
    if (Number.isFinite(n)) return Math.round(n * 100);
  }
  return null;
}

/** Integer count from the legacy integer field or a `*_fp` string. */
export function countFrom(intVal: unknown, fpVal: unknown): number | null {
  if (typeof intVal === "number" && Number.isFinite(intVal)) return Math.round(intVal);
  if (typeof intVal === "string" && intVal.trim() !== "") {
    const n = Number.parseFloat(intVal);
    if (Number.isFinite(n)) return Math.round(n);
  }
  if (typeof fpVal === "number" && Number.isFinite(fpVal)) return Math.round(fpVal);
  if (typeof fpVal === "string" && fpVal.trim() !== "") {
    const n = Number.parseFloat(fpVal);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

export function normalizeMarket(raw: KalshiMarket): KalshiMarket {
  return {
    ...raw,
    yes_bid: centsFrom(raw.yes_bid, raw.yes_bid_dollars),
    yes_ask: centsFrom(raw.yes_ask, raw.yes_ask_dollars),
    no_bid: centsFrom(raw.no_bid, raw.no_bid_dollars),
    no_ask: centsFrom(raw.no_ask, raw.no_ask_dollars),
    last_price: centsFrom(raw.last_price, raw.last_price_dollars),
    volume: countFrom(raw.volume, raw.volume_fp),
    open_interest: countFrom(raw.open_interest, raw.open_interest_fp),
    liquidity: centsFrom(raw.liquidity, raw.liquidity_dollars),
  };
}

function normalizeEvent(event: KalshiEvent): KalshiEvent {
  return { ...event, markets: (event.markets ?? []).map(normalizeMarket) };
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
