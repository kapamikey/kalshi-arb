import { assertDemoRestBase, isProductionTradeHost, ProductionHostError, signingPath } from "./hosts.ts";
import { loadPrivateKey, signedHeaders } from "./sign.ts";
import type { KeyObject } from "node:crypto";
import type { KalshiEvent, KalshiMarket } from "../supabase/functions/scan/kalshi.ts";
export class KalshiError extends Error {
  constructor(readonly status: number, readonly body: string) { super(`Kalshi API ${status}: ${body.slice(0, 240)}`); this.name = "KalshiError"; }
}
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export interface DemoClientOpts { restBase: string; apiKeyId?: string; privateKeyPem?: string; fetch?: FetchFn; userAgent?: string; }
export class DemoKalshiClient {
  readonly restBase: string;
  private readonly keyId: string;
  private readonly key: KeyObject | null;
  private readonly fetchFn: FetchFn;
  private readonly userAgent: string;
  constructor(opts: DemoClientOpts) {
    this.restBase = assertDemoRestBase(opts.restBase);
    this.keyId = opts.apiKeyId?.trim() ?? "";
    this.key = opts.privateKeyPem?.trim() ? loadPrivateKey(opts.privateKeyPem) : null;
    this.fetchFn = opts.fetch ?? fetch;
    this.userAgent = opts.userAgent ?? "kalshi-arb-demo-trader/1.0";
  }
  private url(path: string): string {
    if (path.includes("://") || isProductionTradeHost(path)) throw new ProductionHostError(`REFUSING non-relative Kalshi path: ${path}`);
    return this.restBase + (path.startsWith("/") ? path : `/${path}`);
  }
  async request<T>(method: string, path: string, opts: { body?: unknown; signed?: boolean; params?: Record<string, string> } = {}): Promise<T> {
    const [pathOnly, query] = path.split("?");
    const url = new URL(this.url(pathOnly ?? path));
    if (query) new URLSearchParams(query).forEach((v, k) => url.searchParams.set(k, v));
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
    if (isProductionTradeHost(url.hostname) || url.hostname !== new URL(this.restBase).hostname) {
      throw new ProductionHostError(`REFUSING resolved host ${url.hostname} (configured ${this.restBase})`);
    }
    assertDemoRestBase(this.restBase);
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": this.userAgent };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.signed) {
      if (!this.key || !this.keyId) throw new Error("signed request requires KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY");
      Object.assign(headers, signedHeaders({ keyId: this.keyId, key: this.key, method, path: signingPath(url.pathname) }));
    }
    const res = await this.fetchFn(url.toString(), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    if (!res.ok) throw new KalshiError(res.status, text);
    return text ? JSON.parse(text) as T : {} as T;
  }
  async getPublic<T>(path: string, params: Record<string, string> = {}): Promise<T> { return this.request<T>("GET", path, { params, signed: false }); }
  async signed<T>(method: string, path: string, body?: unknown): Promise<T> { return this.request<T>(method, path, { body, signed: true }); }
  async fetchOpenEvents(opts: { maxPages?: number; pageLimit?: number } = {}): Promise<KalshiEvent[]> {
    const maxPages = opts.maxPages ?? 20; const pageLimit = opts.pageLimit ?? 200;
    const events: KalshiEvent[] = []; let cursor = "";
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { status: "open", with_nested_markets: "true", limit: String(pageLimit) };
      if (cursor) params.cursor = cursor;
      const body = await this.getPublic<{ events?: KalshiEvent[]; cursor?: string }>("/events", params);
      events.push(...(body.events ?? []));
      if (!body.cursor || body.cursor === cursor) break;
      cursor = body.cursor;
    }
    return events;
  }
  async fetchMarketsByTickers(tickers: string[]): Promise<KalshiMarket[]> {
    const out: KalshiMarket[] = []; const BATCH = 100;
    for (let i = 0; i < tickers.length; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH); let cursor = "";
      for (let page = 0; page < 5; page++) {
        const params: Record<string, string> = { tickers: batch.join(","), limit: String(BATCH) };
        if (cursor) params.cursor = cursor;
        const body = await this.getPublic<{ markets?: KalshiMarket[]; cursor?: string }>("/markets", params);
        out.push(...(body.markets ?? []));
        if (!body.cursor || body.cursor === cursor) break;
        cursor = body.cursor;
      }
    }
    return out;
  }
}
