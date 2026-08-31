import { WebSocket } from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_FEE_RATE, scanEvent, type ScanConfig } from "../supabase/functions/scan/arb.ts";
import type { KalshiEvent, KalshiMarket } from "../supabase/functions/scan/kalshi.ts";
import { applyDelta, applySnapshot, emptyBook, topOfBook, type Book } from "./books.ts";
import type { DemoKalshiClient } from "./client.ts";
import type { TraderConfig } from "./env.ts";
import { executeBasket } from "./orders.ts";
import { clientKey } from "../supabase/functions/scan/paper.ts";
import { alreadyTried, insertBasket, insertFills, insertOrders, updateBasket, writeHeartbeat } from "./persist.ts";
import { WS_SIGN_PATH } from "./hosts.ts";
import { loadPrivateKey, wsHandshakeHeaders } from "./sign.ts";

export function selectUniverse(events: KalshiEvent[], maxMarkets: number): KalshiEvent[] {
  const eligible = events.filter((e) => {
    const all = e.markets ?? []; const active = all.filter((m) => m.status === "active");
    return e.mutually_exclusive && active.length === all.length && active.length >= 2;
  }).sort((a, b) => (a.markets?.length ?? 99) - (b.markets?.length ?? 99));
  const out: KalshiEvent[] = []; let markets = 0;
  for (const e of eligible) { const n = e.markets?.length ?? 0; if (markets + n > maxMarkets) continue; out.push(e); markets += n; }
  return out;
}
function tickersOf(events: KalshiEvent[]): string[] { return events.flatMap((e) => (e.markets ?? []).map((m) => m.ticker)); }
function overlayBook(market: KalshiMarket, book: Book | undefined): KalshiMarket {
  if (!book || book.stale) return market;
  const top = topOfBook(book);
  return { ...market, yes_bid: top.yes_bid ?? market.yes_bid, yes_ask: top.yes_ask ?? market.yes_ask, no_bid: top.no_bid ?? market.no_bid, no_ask: top.no_ask ?? market.no_ask };
}
export async function maybeTradeEvent(cfg: TraderConfig, client: DemoKalshiClient, db: SupabaseClient | null, event: KalshiEvent): Promise<{ tried: boolean; outcome: string | null }> {
  const scanCfg: ScanConfig = { feeRate: DEFAULT_FEE_RATE, minNetEdgeCents: cfg.minNetEdgeCents, contracts: cfg.orderContracts };
  const opps = scanEvent(event, scanCfg); if (!opps.length) return { tried: false, outcome: null };
  const opp = opps[0];
  if (!cfg.tradingEnabled) return { tried: false, outcome: "skipped" };
  if (!db) return { tried: false, outcome: "no-db" };
  if (await alreadyTried(db, opp)) return { tried: false, outcome: "duplicate" };
  const basketId = await insertBasket(db, opp, "submitted");
  await writeHeartbeat(db, { tradingEnabled: true, env: cfg.env, restHost: cfg.restBase, tryingEventTicker: opp.eventTicker, lastError: null });
  const result = await executeBasket({ client, timeInForce: cfg.timeInForce, tradingEnabled: true }, clientKey(opp), opp);
  await insertOrders(db, basketId, result.orders, cfg.timeInForce);
  if (result.orders.some((o) => o.fillCount > 0)) { try { await insertFills(db, basketId, result.orders); } catch { /* best-effort */ } }
  await updateBasket(db, basketId, { status: result.outcome, fail_reason: result.failReason });
  return { tried: true, outcome: result.outcome };
}
interface WsMsg { type?: string; seq?: number; msg?: Record<string, unknown>; }
export class TraderLoop {
  private books = new Map<string, Book>(); private events: KalshiEvent[] = []; private ws: WebSocket | null = null;
  private cmdId = 1; private stopped = false; private lastError: string | null = null; private trying: string | null = null;
  private inFlight = new Set<string>();
  constructor(private readonly cfg: TraderConfig, private readonly client: DemoKalshiClient, private readonly db: SupabaseClient | null) {}
  async start() {
    await this.heartbeat(); await this.refreshUniverse();
    if (this.cfg.apiKeyId && this.cfg.privateKeyPem) this.connectWs(); else console.log("trader: no API key; WS skipped (trading is off)");
    this.timers();
  }
  stop() { this.stopped = true; this.ws?.close(); }
  private timers() {
    const uni = setInterval(() => { if (this.stopped) return clearInterval(uni); void this.refreshUniverse().catch((e) => { this.lastError = e instanceof Error ? e.message : String(e); console.error("universe refresh", this.lastError); }); }, this.cfg.universeRefreshMs);
    const hb = setInterval(() => { if (this.stopped) return clearInterval(hb); void this.heartbeat().catch((e) => console.error("heartbeat", e)); }, this.cfg.heartbeatMs);
  }
  private async heartbeat() {
    if (!this.db) return;
    await writeHeartbeat(this.db, { tradingEnabled: this.cfg.tradingEnabled, env: this.cfg.env, restHost: this.cfg.restBase, tryingEventTicker: this.trying, lastError: this.lastError });
  }
  private async refreshUniverse() {
    const all = await this.client.fetchOpenEvents();
    this.events = selectUniverse(all, this.cfg.maxSubscriptions);
    const tickers = tickersOf(this.events);
    console.log(`trader: universe ${this.events.length} events / ${tickers.length} markets on ${this.cfg.restBase}`);
    for (const t of tickers) if (!this.books.has(t)) this.books.set(t, emptyBook(t));
    if (this.ws && this.ws.readyState === WebSocket.OPEN && tickers.length) {
      this.send({ id: this.cmdId++, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_tickers: tickers } });
    }
    await this.scanAll();
  }
  private connectWs() {
    const key = loadPrivateKey(this.cfg.privateKeyPem);
    const headers = wsHandshakeHeaders({ keyId: this.cfg.apiKeyId, key });
    const ws = new WebSocket(this.cfg.wsUrl, { headers }); this.ws = ws;
    ws.on("open", () => {
      console.log(`trader: WS connected ${this.cfg.wsUrl} (signed GET ${WS_SIGN_PATH})`);
      const tickers = tickersOf(this.events);
      if (tickers.length) this.send({ id: this.cmdId++, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_tickers: tickers } });
    });
    ws.on("message", (data) => { try { this.onWs(JSON.parse(String(data)) as WsMsg); } catch (e) { console.error("ws parse", e); } });
    ws.on("close", () => { if (this.stopped) return; console.log("trader: WS closed; reconnecting in 2s"); setTimeout(() => { if (!this.stopped) this.connectWs(); }, 2000); });
    ws.on("error", (err) => { this.lastError = err.message; console.error("ws error", err.message); });
  }
  private send(obj: unknown) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  private onWs(msg: WsMsg) {
    if (msg.type === "orderbook_snapshot" && msg.msg) {
      const ticker = String(msg.msg.market_ticker ?? "");
      const book = this.books.get(ticker) ?? emptyBook(ticker);
      applySnapshot(book, msg.msg as { yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][] }, msg.seq ?? 0);
      this.books.set(ticker, book); void this.scanTicker(ticker);
    } else if (msg.type === "orderbook_delta" && msg.msg) {
      const ticker = String(msg.msg.market_ticker ?? ""); const book = this.books.get(ticker); if (!book) return;
      if (!applyDelta(book, msg.msg as { price_dollars: string; delta_fp: string; side: "yes" | "no" }, msg.seq ?? 0)) return;
      void this.scanTicker(ticker);
    } else if (msg.type === "error") { this.lastError = JSON.stringify(msg.msg ?? msg).slice(0, 300); console.error("ws cmd error", this.lastError); }
  }
  private eventForTicker(ticker: string): KalshiEvent | undefined { return this.events.find((e) => (e.markets ?? []).some((m) => m.ticker === ticker)); }
  private liveEvent(event: KalshiEvent): KalshiEvent { return { ...event, markets: (event.markets ?? []).map((m) => overlayBook(m, this.books.get(m.ticker))) }; }
  private async scanTicker(ticker: string) { const event = this.eventForTicker(ticker); if (event) await this.scanOne(event); }
  private async scanAll() { for (const e of this.events) await this.scanOne(e); }
  private async scanOne(event: KalshiEvent) {
    if (this.inFlight.has(event.event_ticker)) return;
    this.inFlight.add(event.event_ticker);
    try {
      const live = this.liveEvent(event); this.trying = live.event_ticker;
      const res = await maybeTradeEvent(this.cfg, this.client, this.db, live);
      if (res.tried) console.log(`trader: ${live.event_ticker} -> ${res.outcome}`);
      if (res.outcome && res.outcome !== "skipped" && res.outcome !== "duplicate") this.lastError = res.outcome === "filled" ? null : (res.outcome ?? null);
    } catch (e) { this.lastError = e instanceof Error ? e.message : String(e); console.error("scan", event.event_ticker, this.lastError); }
    finally { this.inFlight.delete(event.event_ticker); this.trying = null; }
  }
}
