export type LevelMap = Map<number, number>;
export interface Book { ticker: string; yes: LevelMap; no: LevelMap; seq: number | null; stale: boolean; }
export function emptyBook(ticker: string): Book { return { ticker, yes: new Map(), no: new Map(), seq: null, stale: true }; }
function cents(priceDollars: string | number): number {
  const n = typeof priceDollars === "number" ? priceDollars : Number.parseFloat(priceDollars);
  return Math.round(n * 100);
}
function size(raw: string | number): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}
export function applySnapshot(book: Book, msg: { yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][] }, seq: number): void {
  book.yes = new Map(); book.no = new Map();
  for (const [p, s] of msg.yes_dollars_fp ?? []) { const c = cents(p); const n = size(s); if (c > 0 && n > 0) book.yes.set(c, n); }
  for (const [p, s] of msg.no_dollars_fp ?? []) { const c = cents(p); const n = size(s); if (c > 0 && n > 0) book.no.set(c, n); }
  book.seq = seq; book.stale = false;
}
export function applyDelta(book: Book, msg: { price_dollars: string; delta_fp: string; side: "yes" | "no" }, seq: number): boolean {
  if (book.seq !== null && seq !== book.seq + 1) { book.stale = true; return false; }
  const c = cents(msg.price_dollars);
  const levels = msg.side === "yes" ? book.yes : book.no;
  const next = (levels.get(c) ?? 0) + size(msg.delta_fp);
  if (next <= 0.0001) levels.delete(c); else levels.set(c, next);
  book.seq = seq; return true;
}
function bestBid(levels: LevelMap): number | null {
  let best = 0; for (const px of levels.keys()) if (px > best) best = px;
  return best > 0 && best < 100 ? best : null;
}
export function topOfBook(book: Book): { yes_bid: number | null; yes_ask: number | null; no_bid: number | null; no_ask: number | null } {
  const yesBid = bestBid(book.yes); const noBid = bestBid(book.no);
  return { yes_bid: yesBid, no_bid: noBid, yes_ask: noBid != null ? 100 - noBid : null, no_ask: yesBid != null ? 100 - yesBid : null };
}
