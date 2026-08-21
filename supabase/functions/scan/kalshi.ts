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

/**
 * Sports series prefixes. Kalshi encodes the sport in the series ticker, and the
 * `category` field is not reliably populated on the events endpoint, so prefix
 * matching is the sturdier filter.
 */
export const SPORTS_SERIES_PREFIXES = [
  "KXNFL", "KXNBA", "KXMLB", "KXNHL", "KXWNBA", "KXNCAA", "KXCFB", "KXCBB",
  "KXEPL", "KXUCL", "KXLALIGA", "KXSERIEA", "KXBUNDESLIGA", "KXLIGUE1",
  "KXMLS", "KXUEFA", "KXFIFA", "KXCPLMATCH", "KXARGNACB",
  "KXT20MATCH", "KXTEST", "KXODI",
  "KXATP", "KXWTA", "KXTENNIS", "KXUFC", "KXBOXING", "KXF1", "KXNASCAR",
  "KXGOLF", "KXPGA", "KXMASTERS",
];

export function isSportsEvent(event: KalshiEvent, prefixes = SPORTS_SERIES_PREFIXES): boolean {
  const series = event.series_ticker ?? "";
  if (series && prefixes.some((p) => series.startsWith(p))) return true;
  return (event.category ?? "").toLowerCase() === "sports";
}
