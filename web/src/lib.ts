import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_SUPABASE_URL = "https://tymnlqhakjnqwxcainwx.supabase.co";
export const STALE_AFTER_MS = 10 * 60 * 1000;
const STORAGE_KEY = "kalshi-arb-dashboard-anon";

export type ScanRun = {
  id: number;
  ts: string;
  events: number;
  markets: number;
  opportunities: number;
  positions_opened: number;
  positions_settled: number;
  duration_ms: number | null;
  ok: boolean;
  error: string | null;
};

export type ArbLeg = {
  ticker: string;
  side: "yes" | "no" | string;
  priceCents: number;
  contracts: number;
};

export type PaperPosition = {
  id: number;
  client_key: string;
  opened_ts: string;
  event_ticker: string;
  series_ticker: string | null;
  title: string | null;
  kind: "overround" | "underround" | string;
  legs: ArbLeg[] | unknown;
  contracts: number;
  cost_cents: number;
  fee_cents: number;
  guaranteed_payout_cents: number;
  locked_pnl_cents: number;
  status: "open" | "settled" | string;
  close_time: string | null;
  settled_ts: string | null;
  payout_cents: number | null;
  realized_pnl_cents: number | null;
};

export type MarketSnapshot = {
  id: number;
  run_id: number | null;
  ts: string;
  ticker: string;
  event_ticker: string;
  series_ticker: string | null;
  title: string | null;
  status: string | null;
  yes_bid: number | null;
  yes_ask: number | null;
  no_bid: number | null;
  no_ask: number | null;
  last_price: number | null;
  volume: number | null;
  open_interest: number | null;
  liquidity: number | null;
  close_time: string | null;
};

export type PaperEquity = {
  ts: string;
  account_value: number;
  source: "portfolio_snapshots";
};

export type LoadErrorKind = "missing_key" | "rls" | "network" | "other";

export const TRADER_STATUS_BASKET = "__trader__";

export type DemoOrder = {
  id: number;
  basket_id: string;
  ticker: string;
  side: string;
  status: string;
  kalshi_order_id: string | null;
  reject_reason: string | null;
  ts: string;
  event_ticker: string | null;
  kind: string | null;
  client_order_id: string | null;
};

export type DashboardData = {
  runs: ScanRun[];
  latest: ScanRun | null;
  lastOk: ScanRun | null;
  stale: boolean;
  positions: PaperPosition[];
  snapshots: MarketSnapshot[];
  equity: PaperEquity | null;
  snapshotCount: number | null;
  demoOrders: DemoOrder[];
  traderStatus: DemoOrder | null;
};

export function envAnonKey(): string {
  return (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? "";
}

export function envUrl(): string {
  const fromEnv = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  return fromEnv || DEFAULT_SUPABASE_URL;
}

export function storedAnonKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveAnonKey(key: string) {
  localStorage.setItem(STORAGE_KEY, key.trim());
}

export function clearStoredAnonKey() {
  localStorage.removeItem(STORAGE_KEY);
}

export function activeAnonKey(): string {
  return envAnonKey() || storedAnonKey();
}

export function makeClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function dollarsFromCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function dollars(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "—";
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

const NY: Intl.DateTimeFormatOptions = {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
  timeZoneName: "short",
};

export function fmtNy(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", NY);
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function classifyError(message: string): LoadErrorKind {
  const m = message.toLowerCase();
  if (m.includes("missing") && m.includes("key")) return "missing_key";
  if (
    m.includes("permission denied") ||
    m.includes("row-level security") ||
    m.includes("rls") ||
    m.includes("not acceptable") ||
    m.includes("jwt") ||
    m.includes("invalid api key")
  ) {
    return "rls";
  }
  if (m.includes("fetch") || m.includes("network") || m.includes("failed to fetch")) return "network";
  return "other";
}

export function asLegs(raw: unknown): ArbLeg[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is ArbLeg => !!l && typeof l === "object" && "ticker" in l);
}

function sanitizeSearch(q: string): string {
  return q.replace(/[,()%.]/g, " ").trim().slice(0, 64);
}


export function traderSentence(row: DemoOrder | null): string {
  if (!row || row.status === "off") return "Trader OFF";
  if (row.status === "watching") return "Watching demo. No edge.";
  if (row.status === "submitted" || row.status === "filled" || row.status === "cancelled") {
    const kind = row.kind || "basket";
    const event = row.event_ticker || "event";
    return `Submitted ${kind} on ${event}`;
  }
  if (row.status === "rejected") {
    return `Demo rejected: ${row.reject_reason || "unknown"}`;
  }
  if (row.status === "no_edge") return "Watching demo. No edge.";
  return "Trader OFF";
}

export function demoOrderSentence(row: DemoOrder, now = Date.now()): string {
  const when = `${fmtNy(row.ts)} · ${ago(row.ts, now)}`;
  const side = row.side === "no" ? "NO" : "YES";
  if (row.status === "rejected") {
    const reason = row.reject_reason ? ` (${row.reject_reason})` : "";
    return `${when}: tried ${side} ${row.ticker} — rejected${reason}`;
  }
  if (row.status === "filled") {
    const id = row.kalshi_order_id ? ` ${row.kalshi_order_id}` : "";
    return `${when}: buy ${side} ${row.ticker} — filled${id}`;
  }
  if (row.status === "submitted") {
    const id = row.kalshi_order_id ? ` ${row.kalshi_order_id}` : "";
    return `${when}: buy ${side} ${row.ticker} — submitted${id}`;
  }
  return `${when}: ${side} ${row.ticker} — ${row.status}`;
}

export async function loadDashboard(
  db: SupabaseClient,
  opts: { search: string; kxnfl: boolean },
): Promise<DashboardData> {
  const runsRes = await db
    .from("scan_runs")
    .select(
      "id, ts, events, markets, opportunities, positions_opened, positions_settled, duration_ms, ok, error",
    )
    .order("ts", { ascending: false })
    .limit(20);

  if (runsRes.error) throw new Error(runsRes.error.message);

  const runs = (runsRes.data ?? []) as ScanRun[];
  const latest = runs[0] ?? null;
  const lastOk = runs.find((r) => r.ok) ?? null;
  const stale = !lastOk || Date.now() - new Date(lastOk.ts).getTime() > STALE_AFTER_MS;

  const posRes = await db
    .from("paper_positions")
    .select(
      "id, client_key, opened_ts, event_ticker, series_ticker, title, kind, legs, contracts, cost_cents, fee_cents, guaranteed_payout_cents, locked_pnl_cents, status, close_time, settled_ts, payout_cents, realized_pnl_cents",
    )
    .order("opened_ts", { ascending: false })
    .limit(500);

  if (posRes.error) throw new Error(posRes.error.message);
  const positions = (posRes.data ?? []) as PaperPosition[];

  let equity: PaperEquity | null = null;
  const eqRes = await db
    .from("portfolio_snapshots")
    .select("ts, account_value, paper")
    .eq("paper", true)
    .order("ts", { ascending: false })
    .limit(1);

  if (!eqRes.error && eqRes.data && eqRes.data.length > 0) {
    const row = eqRes.data[0] as { ts: string; account_value: number };
    equity = { ts: row.ts, account_value: row.account_value, source: "portfolio_snapshots" };
  }

  let snapshots: MarketSnapshot[] = [];
  let snapshotCount: number | null = null;
  if (latest) {
    let q = db
      .from("market_snapshots")
      .select(
        "id, run_id, ts, ticker, event_ticker, series_ticker, title, status, yes_bid, yes_ask, no_bid, no_ask, last_price, volume, open_interest, liquidity, close_time",
        { count: "exact" },
      )
      .eq("run_id", latest.id)
      .order("ticker", { ascending: true })
      .limit(80);

    if (opts.kxnfl) q = q.ilike("series_ticker", "KXNFL%");
    const search = sanitizeSearch(opts.search);
    if (search) {
      q = q.or(
        `ticker.ilike.%${search}%,event_ticker.ilike.%${search}%,series_ticker.ilike.%${search}%,title.ilike.%${search}%`,
      );
    }

    const snapRes = await q;
    if (snapRes.error) throw new Error(snapRes.error.message);
    snapshots = (snapRes.data ?? []) as MarketSnapshot[];
    snapshotCount = snapRes.count ?? snapshots.length;
  }

  const DEMO_COLS =
    "id, basket_id, ticker, side, status, kalshi_order_id, reject_reason, ts, event_ticker, kind, client_order_id";

  let demoOrders: DemoOrder[] = [];
  let traderStatus: DemoOrder | null = null;
  const statusRes = await db
    .from("demo_orders")
    .select(DEMO_COLS)
    .eq("basket_id", TRADER_STATUS_BASKET)
    .order("ts", { ascending: false })
    .limit(1);
  if (!statusRes.error) {
    traderStatus = ((statusRes.data ?? [])[0] as DemoOrder | undefined) ?? null;
  }
  const demoRes = await db
    .from("demo_orders")
    .select(DEMO_COLS)
    .neq("basket_id", TRADER_STATUS_BASKET)
    .order("ts", { ascending: false })
    .limit(3);
  if (!demoRes.error) {
    demoOrders = (demoRes.data ?? []) as DemoOrder[];
  }

  return { runs, latest, lastOk, stale, positions, snapshots, equity, snapshotCount, demoOrders, traderStatus };
}
