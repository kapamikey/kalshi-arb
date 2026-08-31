/** Kalshi RSA-PSS SHA256. Payload = timestamp + method + path (no query). WS signs GET /trade-api/ws/v2. */
import { constants, createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { signingPath, WS_SIGN_PATH } from "./hosts.ts";
export function loadPrivateKey(pem: string): KeyObject { return createPrivateKey(pem); }
export function signPssText(key: KeyObject, text: string): string {
  const sign = createSign("RSA-SHA256"); sign.update(text); sign.end();
  return sign.sign({ key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }).toString("base64");
}
export function signedHeaders(opts: { keyId: string; key: KeyObject; method: string; path: string; timestampMs?: number; }): Record<string, string> {
  const timestamp = String(opts.timestampMs ?? Date.now());
  const payload = timestamp + opts.method.toUpperCase() + signingPath(opts.path);
  return { "KALSHI-ACCESS-KEY": opts.keyId, "KALSHI-ACCESS-TIMESTAMP": timestamp, "KALSHI-ACCESS-SIGNATURE": signPssText(opts.key, payload) };
}
export function wsHandshakeHeaders(opts: { keyId: string; key: KeyObject; timestampMs?: number }): Record<string, string> {
  return signedHeaders({ keyId: opts.keyId, key: opts.key, method: "GET", path: WS_SIGN_PATH, timestampMs: opts.timestampMs });
}
