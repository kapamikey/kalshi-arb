import http from "node:http";
import { DemoKalshiClient } from "./client.ts";
import { loadTraderConfig } from "./env.ts";
import { TraderLoop } from "./loop.ts";
import { makeDb } from "./persist.ts";
import { assertDemoRestBase, assertDemoWsUrl } from "./hosts.ts";

const cfg = loadTraderConfig();
assertDemoRestBase(cfg.restBase);
assertDemoWsUrl(cfg.wsUrl);
console.log(JSON.stringify({ env: cfg.env, rest: cfg.restBase, ws: cfg.wsUrl, trading: cfg.tradingEnabled, orderContracts: cfg.orderContracts, contractsCap: cfg.contractsCap, tif: cfg.timeInForce }));
if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
  if (cfg.tradingEnabled) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required when trading is enabled");
  console.log("trader: no Supabase credentials; heartbeat/ledger disabled");
}
const client = new DemoKalshiClient({ restBase: cfg.restBase, apiKeyId: cfg.apiKeyId, privateKeyPem: cfg.privateKeyPem });
const db = cfg.supabaseUrl && cfg.supabaseServiceRoleKey ? makeDb(cfg.supabaseUrl, cfg.supabaseServiceRoleKey) : null;
const loop = new TraderLoop(cfg, client, db);
const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, env: cfg.env, trading: cfg.tradingEnabled, rest: cfg.restBase, ws: cfg.wsUrl, orderContracts: cfg.orderContracts }));
});
server.listen(cfg.port, () => console.log(`trader: health http://0.0.0.0:${cfg.port}/`));
void loop.start().catch((err) => { console.error("trader fatal", err); process.exit(1); });
process.on("SIGTERM", () => { loop.stop(); server.close(() => process.exit(0)); });
