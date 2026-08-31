import { assertDemoRestBase, assertDemoWsUrl, DEFAULT_DEMO_REST, DEFAULT_DEMO_WS } from "./hosts.ts";
import { DEFAULT_SCAN_CONFIG } from "../supabase/functions/scan/arb.ts";
export class TraderBootError extends Error { constructor(message: string) { super(message); this.name = "TraderBootError"; } }
export type TimeInForce = "fill_or_kill" | "immediate_or_cancel";
export interface TraderConfig {
  env: "demo"; restBase: string; wsUrl: string; tradingEnabled: boolean;
  apiKeyId: string; privateKeyPem: string; supabaseUrl: string; supabaseServiceRoleKey: string;
  minNetEdgeCents: number; contractsCap: number; orderContracts: number;
  timeInForce: TimeInForce; maxSubscriptions: number; heartbeatMs: number; universeRefreshMs: number; port: number;
}
export type EnvMap = Record<string, string | undefined>;
function envBool(env: EnvMap, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new TraderBootError(`${name} must be true or false, got ${JSON.stringify(env[name])}`);
}
function envInt(env: EnvMap, name: string, fallback: number): number {
  const raw = env[name]?.trim(); if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new TraderBootError(`${name} must be an integer`);
  return n;
}
function readPem(env: EnvMap): string {
  let s = (env.KALSHI_PRIVATE_KEY ?? env.KALSHI_DEMO_PRIVATE_KEY_PEM ?? "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s.replace(/\\n/g, "\n");
}
const ALLOWED_TIF = new Set<TimeInForce>(["fill_or_kill", "immediate_or_cancel"]);
export function loadTraderConfig(env: EnvMap = process.env): TraderConfig {
  const kalshiEnv = (env.KALSHI_ENV ?? "").trim().toLowerCase();
  if (kalshiEnv !== "demo") throw new TraderBootError(`REFUSING to start: KALSHI_ENV must be "demo" (got ${JSON.stringify(env.KALSHI_ENV)}). Live money is a later spec.`);
  const restBase = assertDemoRestBase(env.KALSHI_REST_BASE?.trim() || DEFAULT_DEMO_REST);
  const wsUrl = assertDemoWsUrl(env.KALSHI_WS_URL?.trim() || DEFAULT_DEMO_WS);
  const tradingEnabled = envBool(env, "KALSHI_TRADING_ENABLED", false);
  const apiKeyId = (env.KALSHI_API_KEY_ID ?? env.KALSHI_DEMO_KEY_ID ?? "").trim();
  const privateKeyPem = readPem(env);
  if (tradingEnabled && (!apiKeyId || !privateKeyPem)) {
    throw new TraderBootError("KALSHI_TRADING_ENABLED=true requires KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY (PEM) in env/Vault. Empty keys are a boot fail.");
  }
  const tifRaw = (env.KALSHI_TIME_IN_FORCE ?? "fill_or_kill").trim();
  if (tifRaw === "good_till_canceled" || tifRaw === "gtc" || tifRaw === "GTT") throw new TraderBootError("No resting orders. KALSHI_TIME_IN_FORCE cannot be GTC.");
  if (!ALLOWED_TIF.has(tifRaw as TimeInForce)) throw new TraderBootError(`KALSHI_TIME_IN_FORCE must be fill_or_kill or immediate_or_cancel, got ${tifRaw}`);
  const contractsCap = Math.max(1, envInt(env, "CONTRACTS", DEFAULT_SCAN_CONFIG.contracts));
  let orderContracts = envInt(env, "DEMO_ORDER_CONTRACTS", 1);
  if (orderContracts < 1) orderContracts = 1;
  if (orderContracts > contractsCap) orderContracts = contractsCap;
  return { env: "demo", restBase, wsUrl, tradingEnabled, apiKeyId, privateKeyPem,
    supabaseUrl: env.SUPABASE_URL?.trim() ?? "", supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "",
    minNetEdgeCents: envInt(env, "MIN_NET_EDGE_CENTS", DEFAULT_SCAN_CONFIG.minNetEdgeCents),
    contractsCap, orderContracts, timeInForce: tifRaw as TimeInForce,
    maxSubscriptions: Math.max(2, envInt(env, "MAX_SUBSCRIPTIONS", 40)),
    heartbeatMs: Math.max(5_000, envInt(env, "HEARTBEAT_MS", 15_000)),
    universeRefreshMs: Math.max(10_000, envInt(env, "UNIVERSE_REFRESH_MS", 60_000)),
    port: envInt(env, "PORT", 8080) };
}
