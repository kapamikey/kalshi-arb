import { useCallback, useEffect, useMemo, useState } from "react";
import {
  activeAnonKey,
  ago,
  asLegs,
  classifyError,
  clearStoredAnonKey,
  dollars,
  dollarsFromCents,
  envAnonKey,
  envUrl,
  fmtNy,
  loadDashboard,
  makeClient,
  saveAnonKey,
  type DashboardData,
  type LoadErrorKind,
  type PaperPosition,
} from "./lib";

type StatusFilter = "all" | "open" | "settled";

const emptyData: DashboardData = {
  runs: [],
  latest: null,
  lastOk: null,
  stale: true,
  positions: [],
  snapshots: [],
  equity: null,
  equityError: null,
  snapshotCount: null,
};

function pnlClass(cents: number | null | undefined): string {
  if (cents == null) return "num";
  if (cents > 0) return "num pos";
  if (cents < 0) return "num neg";
  return "num";
}

export default function App() {
  const url = envUrl();
  const [anonKey, setAnonKey] = useState(activeAnonKey);
  const [draftKey, setDraftKey] = useState("");
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(() => Boolean(activeAnonKey()));
  const [ready, setReady] = useState(() => !activeAnonKey());
  const [err, setErr] = useState<string | null>(null);
  const [errKind, setErrKind] = useState<LoadErrorKind | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [kxnfl, setKxnfl] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput), 400);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(async () => {
    const key = activeAnonKey();
    setAnonKey(key);
    if (!key) {
      setErr("Missing VITE_SUPABASE_ANON_KEY.");
      setErrKind("missing_key");
      setData(emptyData);
      setLoading(false);
      setReady(true);
      return;
    }
    setLoading(true);
    try {
      const next = await loadDashboard(makeClient(url, key), { search, kxnfl });
      setData(next);
      setErr(null);
      setErrKind(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(message);
      setErrKind(classifyError(message));
    } finally {
      setLoading(false);
      setReady(true);
      setNow(Date.now());
    }
  }, [url, search, kxnfl]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const selected = useMemo(
    () => data.positions.find((p) => p.id === selectedId) ?? null,
    [data.positions, selectedId],
  );

  const shown = useMemo(() => {
    if (filter === "all") return data.positions;
    return data.positions.filter((p) => p.status === filter);
  }, [data.positions, filter]);

  const book = useMemo(() => {
    const open = data.positions.filter((p) => p.status === "open");
    const settled = data.positions.filter((p) => p.status === "settled");
    const sum = (rows: PaperPosition[], key: keyof PaperPosition) =>
      rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
    return {
      open: open.length,
      settled: settled.length,
      cost: sum(data.positions, "cost_cents"),
      locked: sum(open, "locked_pnl_cents"),
      realized: sum(settled, "realized_pnl_cents"),
    };
  }, [data.positions]);

  const healthyEmpty =
    data.positions.length === 0 && data.latest?.ok === true && !data.stale && !err;

  const awaitingHealth = !ready || (loading && !data.latest);
  const healthClass = awaitingHealth
    ? "loading"
    : !data.latest || errKind === "missing_key"
      ? "fail"
      : data.stale
        ? "stale"
        : data.latest.ok
          ? "ok"
          : "fail";

  function applyKey() {
    saveAnonKey(draftKey);
    setDraftKey("");
    void load();
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>kalshi-arb</h1>
          <p className="sub">
            Read-only paper book for the 5-minute scanner. No orders, no Kalshi credentials,
            no service role in the browser.
          </p>
        </div>
        <div className="row-actions">
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <aside className="limits">
        <ul>
          <li>A 5-minute poll rarely catches a live arb. This page is quote history + paper book.</li>
          <li>Locked P&amp;L is an upper bound. Fill risk is not modelled. Depth is unknown (CONTRACTS defaults to 20).</li>
          <li>Every paper fill assumes crossing the spread, not mids.</li>
        </ul>
      </aside>

      {(errKind === "missing_key" || (!envAnonKey() && anonKey)) && (
        <section className={`banner ${errKind === "missing_key" ? "err" : "warn"}`}>
          <strong>
            {errKind === "missing_key"
              ? "Anon key not configured"
              : "Using a locally pasted anon key"}
          </strong>
          <p className="muted" style={{ margin: "0 0 8px" }}>
            Set <code>VITE_SUPABASE_ANON_KEY</code> (and optionally{" "}
            <code>VITE_SUPABASE_URL</code>) in <code>web/.env</code>. Never put{" "}
            <code>SUPABASE_SERVICE_ROLE_KEY</code> here. Project:{" "}
            <code>axdikbsghdotugnotzof</code>. Pasting below stores the anon key in this
            browser only — not an account.
          </p>
          <div className="key-form">
            <input
              type="password"
              placeholder="eyJ…  supabase anon / publishable key"
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              autoComplete="off"
            />
            <button type="button" className="primary" onClick={applyKey} disabled={!draftKey.trim()}>
              Use key
            </button>
            {anonKey && !envAnonKey() && (
              <button
                type="button"
                onClick={() => {
                  clearStoredAnonKey();
                  setAnonKey("");
                  void load();
                }}
              >
                Clear
              </button>
            )}
          </div>
        </section>
      )}

      {err && errKind !== "missing_key" && (
        <section className="banner err">
          <strong>
            {errKind === "rls"
              ? "Could not read scanner tables"
              : "Load failed"}
          </strong>
          <p className="err-text">{err}</p>
          {errKind === "rls" && (
            <p className="muted">
              Anon reads need the SELECT policies in{" "}
              <code>supabase/migrations/20260830_dashboard_read.sql</code>. Apply with{" "}
              <code>supabase db push</code>. Confirm you pasted the anon key, not the
              service role.
            </p>
          )}
        </section>
      )}

      <section className={`health ${healthClass}`}>
        <div className="health-head">
          <div>
            {healthClass === "loading" && <span className="pill loading">Loading</span>}
            {healthClass === "ok" && <span className="pill ok">Scanner ok</span>}
            {healthClass === "stale" && <span className="pill stale">Stale</span>}
            {healthClass === "fail" && <span className="pill fail">Unhealthy</span>}
            <span className="muted" style={{ marginLeft: 8 }}>
              {healthClass === "loading"
                ? "Checking scan_runs…"
                : data.latest
                  ? `${fmtNy(data.latest.ts)} · ${ago(data.latest.ts, now)}`
                  : "no scan_runs yet"}
            </span>
          </div>
          {data.latest?.duration_ms != null && (
            <span className="muted num">{data.latest.duration_ms} ms</span>
          )}
        </div>
        {healthClass !== "loading" && data.stale && data.lastOk && (
          <p style={{ margin: "8px 0 0" }}>
            Last successful scan was {ago(data.lastOk.ts, now)} ({fmtNy(data.lastOk.ts)}).
            Cron is every 5 minutes — older than 10 minutes means the job is likely dead.
          </p>
        )}
        {healthClass !== "loading" && !err && data.stale && !data.lastOk && (
          <p style={{ margin: "8px 0 0" }}>
            No successful <code>scan_runs</code> in the last 20 rows. Absence of rows is
            the alert that the cron died.
          </p>
        )}
        {data.latest && !data.latest.ok && (
          <p className="err-text" style={{ margin: "8px 0 0" }}>
            Last run failed: {data.latest.error || "ok = false, no error text"}
          </p>
        )}
        <div className="stats">
          <div className="stat"><div className="k">Events</div><div className="v num">{healthClass === "loading" ? <span className="skel" /> : (data.latest?.events ?? "—")}</div></div>
          <div className="stat"><div className="k">Markets</div><div className="v num">{healthClass === "loading" ? <span className="skel" /> : (data.latest?.markets ?? "—")}</div></div>
          <div className="stat"><div className="k">Opportunities</div><div className="v num">{healthClass === "loading" ? <span className="skel" /> : (data.latest?.opportunities ?? "—")}</div></div>
          <div className="stat"><div className="k">Opened</div><div className="v num">{healthClass === "loading" ? <span className="skel" /> : (data.latest?.positions_opened ?? "—")}</div></div>
          <div className="stat"><div className="k">Settled</div><div className="v num">{healthClass === "loading" ? <span className="skel" /> : (data.latest?.positions_settled ?? "—")}</div></div>
          <div className="stat">
            <div className="k">Paper equity</div>
            <div className="v num">{healthClass === "loading" ? <span className="skel" /> : data.equityError ? "unreadable" : dollars(data.equity?.account_value)}</div>
          </div>
        </div>
        {data.equity && (
          <p className="muted" style={{ margin: "8px 0 0" }}>
            Latest paper portfolio_snapshots · {fmtNy(data.equity.ts)}
          </p>
        )}
        {!data.equity && data.equityError && (
          <p className="muted" style={{ margin: "8px 0 0" }}>
            Could not read paper portfolio_snapshots ({data.equityError}). Apply{" "}
            <code>supabase/migrations/20260831_paper_portfolio_read.sql</code>{" "}
            with <code>supabase db push</code> (or the SQL editor). Whale rows stay hidden.
          </p>
        )}
      </section>

      <section className="panel">
        <div className="section-h">
          <h2>Paper book</h2>
          <div className="row-actions">
            {(["all", "open", "settled"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`chip ${filter === f ? "on" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f}
                {f === "open" ? ` ${book.open}` : f === "settled" ? ` ${book.settled}` : ` ${data.positions.length}`}
              </button>
            ))}
          </div>
        </div>
        <div className="stats" style={{ marginTop: 0, marginBottom: 10 }}>
          <div className="stat"><div className="k">Cost</div><div className="v num">{dollarsFromCents(book.cost)}</div></div>
          <div className="stat"><div className="k">Locked P&amp;L (open)</div><div className={`v ${pnlClass(book.locked)}`}>{dollarsFromCents(book.locked)}</div></div>
          <div className="stat"><div className="k">Realised P&amp;L</div><div className={`v ${pnlClass(book.realized)}`}>{dollarsFromCents(book.realized)}</div></div>
        </div>

        {!ready && shown.length === 0 && !err && (
          <div className="empty">Loading paper book…</div>
        )}

        {ready && healthyEmpty && (
          <div className="empty">
            <strong>No exploitable cross-outcome mispricing at this 5-minute cadence.</strong>
            Scanner is healthy. An empty paper book is a real result, not a bug. Intra-market YES+NO is never arb.
          </div>
        )}

        {ready && !healthyEmpty && shown.length === 0 && !err && (
          <div className="empty">
            <strong>No {filter === "all" ? "paper" : filter} positions.</strong>
            {data.stale || !data.latest?.ok
              ? " Scanner is not healthy, so this is not a clean empty result."
              : null}
          </div>
        )}

        {shown.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Opened</th>
                  <th>Event</th>
                  <th>Kind</th>
                  <th>Qty</th>
                  <th>Cost</th>
                  <th>Fees</th>
                  <th>Locked</th>
                  <th>Status</th>
                  <th>Realised</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr
                    key={p.id}
                    className={`clickable ${selectedId === p.id ? "selected" : ""}`}
                    onClick={() => setSelectedId((id) => (id === p.id ? null : p.id))}
                  >
                    <td className="muted num">{fmtNy(p.opened_ts)}</td>
                    <td>
                      <div>{p.title || p.event_ticker}</div>
                      <div className="muted mono">{p.event_ticker}{p.series_ticker ? ` · ${p.series_ticker}` : ""}</div>
                    </td>
                    <td><span className="pill kind">{p.kind}</span></td>
                    <td className="num">{p.contracts}</td>
                    <td className="num">{dollarsFromCents(p.cost_cents)}</td>
                    <td className="num">{dollarsFromCents(p.fee_cents)}</td>
                    <td className={pnlClass(p.locked_pnl_cents)}>{dollarsFromCents(p.locked_pnl_cents)}</td>
                    <td><span className={`pill ${p.status}`}>{p.status}</span></td>
                    <td className={pnlClass(p.realized_pnl_cents)}>{dollarsFromCents(p.realized_pnl_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selected && <PositionDetail position={selected} />}
      </section>

      <section className="panel">
        <div className="section-h">
          <h2>Latest-run snapshots</h2>
          <div className="row-actions">
            <input
              type="text"
              placeholder="ticker / event / series"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <button
              type="button"
              className={`chip ${kxnfl ? "on" : ""}`}
              onClick={() => setKxnfl((v) => !v)}
            >
              KXNFL
            </button>
          </div>
        </div>
        <p className="muted" style={{ margin: "0 0 10px" }}>
          Quote inspector for run {data.latest ? `#${data.latest.id}` : ready ? "—" : "…"}. Not a live blotter.
          {ready && data.snapshotCount != null ? ` Showing ${data.snapshots.length} of ${data.snapshotCount}.` : null}
        </p>
        {!ready && data.snapshots.length === 0 ? (
          <div className="empty">Loading snapshots…</div>
        ) : data.snapshots.length === 0 ? (
          <div className="empty">No snapshots for this run{kxnfl || search ? " with the current filter" : ""}.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Event</th>
                  <th>YES bid/ask</th>
                  <th>NO bid/ask</th>
                  <th>Last</th>
                  <th>Vol</th>
                </tr>
              </thead>
              <tbody>
                {data.snapshots.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.ticker}</td>
                    <td>
                      <div>{s.title || s.event_ticker}</div>
                      <div className="muted mono">{s.event_ticker}{s.series_ticker ? ` · ${s.series_ticker}` : ""}</div>
                    </td>
                    <td className="num">{dollarsFromCents(s.yes_bid)} / {dollarsFromCents(s.yes_ask)}</td>
                    <td className="num">{dollarsFromCents(s.no_bid)} / {dollarsFromCents(s.no_ask)}</td>
                    <td className="num">{dollarsFromCents(s.last_price)}</td>
                    <td className="num">{s.volume ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function PositionDetail({ position }: { position: PaperPosition }) {
  const legs = asLegs(position.legs);
  return (
    <div className="detail">
      <h3>{position.title || position.event_ticker}</h3>
      <div className="kv">
        <div><div className="k muted">Kind</div><div>{position.kind}</div></div>
        <div><div className="k muted">Event</div><div className="mono">{position.event_ticker}</div></div>
        <div><div className="k muted">Cost</div><div className="num">{dollarsFromCents(position.cost_cents)}</div></div>
        <div><div className="k muted">Fees</div><div className="num">{dollarsFromCents(position.fee_cents)}</div></div>
        <div><div className="k muted">Guaranteed payout</div><div className="num">{dollarsFromCents(position.guaranteed_payout_cents)}</div></div>
        <div><div className="k muted">Locked P&amp;L</div><div className={pnlClass(position.locked_pnl_cents)}>{dollarsFromCents(position.locked_pnl_cents)}</div></div>
        {position.status === "settled" && (
          <>
            <div><div className="k muted">Payout</div><div className="num">{dollarsFromCents(position.payout_cents)}</div></div>
            <div><div className="k muted">Realised P&amp;L</div><div className={pnlClass(position.realized_pnl_cents)}>{dollarsFromCents(position.realized_pnl_cents)}</div></div>
            <div><div className="k muted">Settled</div><div>{fmtNy(position.settled_ts)}</div></div>
          </>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Ticker</th>
              <th>Side</th>
              <th>Price</th>
              <th>Contracts</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, i) => (
              <tr key={`${leg.ticker}-${leg.side}-${i}`}>
                <td className="mono">{leg.ticker}</td>
                <td>{leg.side}</td>
                <td className="num">{dollarsFromCents(leg.priceCents)}</td>
                <td className="num">{leg.contracts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
