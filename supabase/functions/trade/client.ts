/**
 * Kill-switch Kalshi DEMO Trade API client.
 *
 * Allowlist only — never production. RSA-PSS SHA256 over timestamp+method+path
 * (no query string). Public GETs are unsigned; POSTs under /portfolio are signed.
 */

import { createSign, constants as cryptoConstants } from "node:crypto";
import type { KalshiEvent, KalshiMarket } from "../scan/kalshi.ts";

export const DEMO_TRADE_BASES = [
  "https://external-api.demo.kalshi.co/trade-api/v2",
  "https://demo-api.kalshi.co/trade-api/v2",
] as const;

export const PRODUCTION_TRADE_HOSTS = [
  "external-api.kalshi.com",
  "api.elections.kalshi.com",
] as const;

export const DEFAULT_DEMO_TRADE_BASE = DEMO_TRADE_BASES[0];

export const TRADER_STATUS_BASKET = "__trader__";
export const TRADER_STATUS_CLIENT_ID = "trader-status";

export class KalshiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Kalshi API ${status}: ${body.slice(0, 200)}`);
    this.name = "KalshiError";
  }
}

export type EnvGetter = (name: string) => string | undefined;

export type TradeEnv = {
  tradingEnabled: boolean;
  apiBase: string;
  apiKeyId: string;
  privateKeyPem: string;
  eventCap: number;
};

export type CreateEventOrderRequest = {
  ticker: string;
  client_order_id: string;
  side: "bid" | "ask";
  count: string;
  price: string;
  time_in_force: "fill_or_kill" | "immediate_or_cancel" | "good_till_canceled";
  self_trade_prevention_type: "taker_at_cross" | "maker";
  post_only?: boolean;
};

export type CreateEventOrderResponse = {
  order_id: string;
  client_order_id?: string;
  fill_count?: string;
  remaining_count?: string;
  average_fill_price?: string;
  ts_ms?: number;
};

function envInt(get: EnvGetter, name: string, fallback: number): number {
  const n = Number.parseInt(get(name) ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === "") return fallback;
  const s = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

export function normalizePem(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (s && !s.includes("BEGIN")) {
    try {
      const decoded = Buffer.from(s, "base64").toString("utf8");
      if (decoded.includes("BEGIN")) s = decoded.trim();
    } catch {
      // leave as-is; boot will fail clearly if trading is on
    }
  }
  return s;
}

export function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Hard allowlist. Throws BEFORE any HTTP if the configured host is production
 * or otherwise not a demo Trade API base.
 */
export function assertDemoTradeBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(
      "Kalshi Trade API base is empty. Demo allowlist: " +
        DEMO_TRADE_BASES.join(", "),
    );
  }

  let url: URL;
  try {
    url = new URL(normalizeBase(trimmed));
  } catch {
    throw new Error(`Kalshi Trade API base is not a URL: ${trimmed}`);
  }

  const host = url.hostname.toLowerCase();
  if ((PRODUCTION_TRADE_HOSTS as readonly string[]).includes(host)) {
    throw new Error(
      `Refusing to start: production Trade API host configured (${host}). ` +
        `Demo allowlist only: ${DEMO_TRADE_BASES.join(", ")}`,
    );
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  const canonical = `${url.protocol}//${host}${path}`;
  const allowed = DEMO_TRADE_BASES.some(
    (b) => normalizeBase(b).toLowerCase() === canonical,
  );
  if (!allowed) {
    throw new Error(
      `Refusing to start: ${canonical} is not a demo Trade API host. ` +
        `Allowlist: ${DEMO_TRADE_BASES.join(", ")}`,
    );
  }
  return canonical;
}

/**
 * Read env and apply the kill-switch. Production hosts throw even when
 * trading is disabled. Empty keys: trading-on fails clearly; trading-off is ok.
 */
export function readTradeEnv(get: EnvGetter): TradeEnv {
  const apiBase = assertDemoTradeBase(
    get("KALSHI_API_BASE") || DEFAULT_DEMO_TRADE_BASE,
  );
  const tradingEnabled = parseBool(get("KALSHI_TRADING_ENABLED"), false);
  const apiKeyId = (get("KALSHI_API_KEY_ID") || get("KALSHI_DEMO_KEY_ID") || "").trim();
  const privateKeyPem = normalizePem(
    get("KALSHI_PRIVATE_KEY") || get("KALSHI_DEMO_PRIVATE_KEY_PEM") || "",
  );
  const eventCap = Math.max(1, Math.min(envInt(get, "DEMO_EVENT_CAP", 20), 50));

  if (tradingEnabled && (!apiKeyId || !privateKeyPem)) {
    throw new Error(
      "KALSHI_TRADING_ENABLED is true but KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY is empty. " +
        "Put the demo key in Vault (not the repo) or set KALSHI_TRADING_ENABLED=false.",
    );
  }

  return { tradingEnabled, apiBase, apiKeyId, privateKeyPem, eventCap };
}

export function signingPathFor(base: string, endpointPath: string): string {
  const path = endpointPath.split("?")[0];
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const full = `${normalizeBase(base)}${suffix}`;
  return new URL(full).pathname;
}

export function messageToSign(
  timestampMs: string,
  method: string,
  urlPath: string,
): string {
  return `${timestampMs}${method.toUpperCase()}${urlPath.split("?")[0]}`;
}

export function signRequest(
  privateKeyPem: string,
  timestampMs: string,
  method: string,
  urlPath: string,
): string {
  const message = messageToSign(timestampMs, method, urlPath);
  const sign = createSign("RSA-SHA256");
  sign.update(message);
  sign.end();
  return sign
    .sign({
      key: privateKeyPem,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
}

export function dollarsPrice(priceCents: number): string {
  return (priceCents / 100).toFixed(4);
}

/**
 * V2 event-order body. YES buy = bid at yes_ask. NO buy = sell YES (ask) at
 * 1 - no_ask, which is economically buying NO at no_ask.
 *
 * OpenAPI time_in_force is fill_or_kill | immediate_or_cancel | good_till_canceled.
 * Friday cut uses fill_or_kill (1 contract; no GTC left on the book).
 */
export function eventOrderBody(
  leg: { ticker: string; side: "yes" | "no"; priceCents: number },
  clientOrderId: string,
): CreateEventOrderRequest {
  const buyYes = leg.side === "yes";
  return {
    ticker: leg.ticker,
    client_order_id: clientOrderId,
    side: buyYes ? "bid" : "ask",
    count: "1.00",
    price: buyYes
      ? dollarsPrice(leg.priceCents)
      : dollarsPrice(100 - leg.priceCents),
    time_in_force: "fill_or_kill",
    self_trade_prevention_type: "taker_at_cross",
    post_only: false,
  };
}

export async function stableClientOrderId(parts: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts),
  );
  const bytes = new Uint8Array(buf).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type DemoKalshiClient = {
  readonly base: string;
  fetchCappedExclusiveEvents: (cap: number) => Promise<KalshiEvent[]>;
  createEventOrder: (
    body: CreateEventOrderRequest,
  ) => Promise<{ status: number; json: CreateEventOrderResponse; text: string }>;
  cancelEventOrder: (orderId: string) => Promise<void>;
};

export function createKalshiDemoClient(opts: {
  apiBase: string;
  apiKeyId: string;
  privateKeyPem: string;
  fetch?: typeof fetch;
  nowMs?: () => number;
}): DemoKalshiClient {
  const base = assertDemoTradeBase(opts.apiBase);
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const nowMs = opts.nowMs ?? Date.now;

  function headers(method: string, endpointPath: string): Record<string, string> {
    const timestamp = String(nowMs());
    const path = signingPathFor(base, endpointPath);
    const signature = signRequest(opts.privateKeyPem, timestamp, method, path);
    return {
      "KALSHI-ACCESS-KEY": opts.apiKeyId,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "KALSHI-ACCESS-SIGNATURE": signature,
      Accept: "application/json",
      "User-Agent": "kalshi-arb-demo-trader/1.0",
    };
  }

  async function unsignedGet<T>(
    endpointPath: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${base}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await doFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "kalshi-arb-demo-trader/1.0",
      },
    });
    if (!res.ok) throw new KalshiError(res.status, await res.text());
    return (await res.json()) as T;
  }

  async function signed(
    method: string,
    endpointPath: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${base}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
    const hdrs = headers(method, endpointPath.split("?")[0]);
    if (body !== undefined) hdrs["Content-Type"] = "application/json";
    return await doFetch(url, {
      method,
      headers: hdrs,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  return {
    base,
    async fetchCappedExclusiveEvents(cap: number): Promise<KalshiEvent[]> {
      const body = await unsignedGet<{ events?: KalshiEvent[] }>("/events", {
        status: "open",
        with_nested_markets: "true",
        limit: "200",
      });
      const events = (body.events ?? []).filter((e) => {
        const markets = (e.markets ?? []) as KalshiMarket[];
        return e.mutually_exclusive === true && markets.length >= 2;
      });
      return events.slice(0, cap);
    },
    async createEventOrder(body) {
      const res = await signed("POST", "/portfolio/events/orders", body);
      const text = await res.text();
      let json = {} as CreateEventOrderResponse;
      try {
        json = text ? (JSON.parse(text) as CreateEventOrderResponse) : json;
      } catch {
        // non-JSON error body
      }
      return { status: res.status, json, text };
    },
    async cancelEventOrder(orderId: string) {
      const res = await signed(
        "DELETE",
        `/portfolio/events/orders/${encodeURIComponent(orderId)}`,
      );
      if (!res.ok && res.status !== 404) {
        throw new KalshiError(res.status, await res.text());
      }
    },
  };
}
