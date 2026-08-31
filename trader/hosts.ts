/**
 * Demo-only Kalshi host allowlist.
 * Production Trade API hosts are a hard crash, not a warning. No I/O here.
 */
export const DEMO_REST_BASES = [
  "https://external-api.demo.kalshi.co/trade-api/v2",
  "https://demo-api.kalshi.co/trade-api/v2",
] as const;
export const DEMO_WS_URLS = [
  "wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2",
  "wss://demo-api.kalshi.co/trade-api/ws/v2",
] as const;
export const DEFAULT_DEMO_REST = DEMO_REST_BASES[0];
export const DEFAULT_DEMO_WS = DEMO_WS_URLS[0];
export const WS_SIGN_PATH = "/trade-api/ws/v2";
export class ProductionHostError extends Error {
  constructor(message: string) { super(message); this.name = "ProductionHostError"; }
}
function normalizeBase(raw: string): string { return raw.trim().replace(/\/+$/, ""); }
function hostnameOf(raw: string): string {
  try { const withScheme = raw.includes("://") ? raw : `https://${raw}`; return new URL(withScheme).hostname.toLowerCase(); }
  catch { return raw.toLowerCase(); }
}
export function isProductionTradeHost(raw: string): boolean {
  const host = hostnameOf(raw);
  return host === "kalshi.com" || host.endsWith(".kalshi.com");
}
export function isAllowedDemoRest(raw: string): boolean {
  return (DEMO_REST_BASES as readonly string[]).includes(normalizeBase(raw));
}
export function isAllowedDemoWs(raw: string): boolean {
  return (DEMO_WS_URLS as readonly string[]).includes(normalizeBase(raw));
}
export function assertDemoRestBase(raw: string): string {
  const n = normalizeBase(raw);
  if (isProductionTradeHost(n) || !isAllowedDemoRest(n)) {
    throw new ProductionHostError(`REFUSING production/unknown Kalshi REST host: ${raw}. Demo only: ${DEMO_REST_BASES.join(" or ")}`);
  }
  return n;
}
export function assertDemoWsUrl(raw: string): string {
  const n = normalizeBase(raw);
  if (isProductionTradeHost(n) || !isAllowedDemoWs(n)) {
    throw new ProductionHostError(`REFUSING production/unknown Kalshi WS host: ${raw}. Demo only: ${DEMO_WS_URLS.join(" or ")}`);
  }
  return n;
}
export function signingPath(urlOrPath: string): string {
  if (urlOrPath.includes("://")) return new URL(urlOrPath).pathname;
  const noQuery = urlOrPath.split("?")[0] ?? urlOrPath;
  return noQuery.startsWith("/") ? noQuery : `/${noQuery}`;
}
