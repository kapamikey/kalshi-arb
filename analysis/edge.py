"""
Out-of-sample wallet edge study.

The claim under test is "rank wallets by past performance, copy the top ones."
The only way to evaluate that is to rank on one window and MEASURE ON A LATER
ONE. Ranking and measuring on the same data selects for luck: with N candidates,
the top of any ranking is dominated by variance, and the more candidates you
screen the more extreme the winner looks.

This module does four things the naive version doesn't:

1. Splits time into a rank window and a disjoint eval window.
2. Measures edge per dollar risked, not raw P&L — otherwise you just select
   whoever bet biggest.
3. Compares the selected wallets against an activity-MATCHED random null, so
   "the top decile made money" can be told apart from "active wallets made money".
4. Reports attrition, because wallets that stop trading between windows are
   silently dropped by every analysis of this kind and they are exactly the
   ones that blew up.

Stdlib only.
"""

from collections import defaultdict
from dataclasses import dataclass
import math
import random

# A single fill. `price` is in probability units (0..1), `size` is shares.
# side is "BUY" or "SELL". outcome identifies which leg of the market.
Trade = tuple  # (wallet, market, outcome, side, price, size, timestamp)

W, M, O, SIDE, PRICE, SIZE, TS = range(7)


@dataclass
class WalletStats:
    wallet: str
    pnl: float          # in dollars
    notional: float     # dollars put at risk (buy side)
    n_trades: int
    n_markets: int

    @property
    def edge(self) -> float:
        """P&L per dollar risked. The scale-free quantity worth ranking on."""
        return self.pnl / self.notional if self.notional > 0 else 0.0


def realized_pnl(trades, resolutions):
    """
    P&L per (wallet, market, outcome), exact for binary contracts.

        pnl = cash_flow + final_position * resolution_value

    Buys are negative cash, sells positive; whatever is still held at
    resolution pays 1 if that outcome won and 0 otherwise. Unresolved markets
    contribute only their realised cash flow and are flagged, since counting an
    open position at cost would let a wallet look flat while sitting on a loss.
    """
    cash = defaultdict(float)
    position = defaultdict(float)

    for t in trades:
        key = (t[W], t[M], t[O])
        notional = t[PRICE] * t[SIZE]
        if t[SIDE] == "BUY":
            cash[key] -= notional
            position[key] += t[SIZE]
        else:
            cash[key] += notional
            position[key] -= t[SIZE]

    out, unresolved = {}, 0
    for key in cash:
        _, market, outcome = key
        res = resolutions.get((market, outcome))
        if res is None:
            out[key] = cash[key]
            unresolved += 1
        else:
            out[key] = cash[key] + position[key] * res
    return out, unresolved


def wallet_stats(trades, resolutions):
    """Aggregate to one row per wallet."""
    pnl_by_key, _ = realized_pnl(trades, resolutions)

    pnl = defaultdict(float)
    for (wallet, _, _), v in pnl_by_key.items():
        pnl[wallet] += v

    notional = defaultdict(float)
    counts = defaultdict(int)
    markets = defaultdict(set)
    for t in trades:
        if t[SIDE] == "BUY":
            notional[t[W]] += t[PRICE] * t[SIZE]
        counts[t[W]] += 1
        markets[t[W]].add(t[M])

    return {
        w: WalletStats(w, pnl[w], notional[w], counts[w], len(markets[w]))
        for w in counts
    }


# --- statistics, stdlib only -------------------------------------------------

def _ranks(xs):
    """Average ranks, ties shared."""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            r[order[k]] = avg
        i = j + 1
    return r


def _pearson(xs, ys):
    n = len(xs)
    if n < 2:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return num / (dx * dy) if dx and dy else 0.0


def spearman(xs, ys):
    """Rank correlation. The single cleanest persistence number."""
    return _pearson(_ranks(xs), _ranks(ys))


def best_of_n_under_null(n_wallets, n_trades, p_win, trials=2000, seed=0):
    """
    How good does the BEST of n zero-edge wallets look?

    Context for any single spectacular wallet. Screening 14,000 candidates and
    reporting the winner's win rate is a maximum, not an estimate — this says
    what that maximum is worth when nobody has any skill at all.
    """
    rng = random.Random(seed)
    best = []
    for _ in range(trials):
        m = max(
            sum(1 for _ in range(n_trades) if rng.random() < p_win)
            for _ in range(min(n_wallets, 400))
        )
        best.append(m / n_trades)
    best.sort()
    return {
        "median_best_win_rate": best[len(best) // 2],
        "p95_best_win_rate": best[int(len(best) * 0.95)],
        "true_win_rate": p_win,
    }


# --- the study ---------------------------------------------------------------

def persistence_study(
    trades,
    resolutions,
    split_ts,
    min_trades=50,
    top_frac=0.10,
    n_null=1000,
    seed=0,
):
    """
    Rank on trades before `split_ts`, evaluate on trades after it.

    `min_trades` defaults to 50 because it is the parameter that decides whether
    this study can conclude anything. On simulated populations where 5% of
    wallets have a large, genuinely persistent edge (+0.35), varying only the
    required track record:

        min_trades   top-decile purity   forward edge
                10                 19%         +0.019
                25                 28%         +0.048
                50                 37%         +0.080
               100                 59%         +0.101

    Below ~50 trades the selected decile is mostly lucky wallets even when real
    sharps exist, and the forward edge collapses toward zero. A ranking built on
    short track records is not a weak signal, it is close to no signal — so a
    thin pool is reported as a power warning rather than a result.

    Returns a dict; every field is meant to be reported, including the ones
    that make the result look worse.
    """
    rank_trades = [t for t in trades if t[TS] < split_ts]
    eval_trades = [t for t in trades if t[TS] >= split_ts]

    rank_stats = wallet_stats(rank_trades, resolutions)
    eval_stats = wallet_stats(eval_trades, resolutions)

    eligible = {w: s for w, s in rank_stats.items() if s.n_trades >= min_trades}
    if not eligible:
        return {"error": "no wallets met min_trades in the rank window"}

    ranked = sorted(eligible.values(), key=lambda s: s.edge, reverse=True)
    k = max(1, int(len(ranked) * top_frac))
    selected = ranked[:k]

    # Attrition: wallets that never trade again are invisible to any forward
    # test. Reporting this stops the survivors from speaking for everyone.
    survivors = [s for s in selected if s.wallet in eval_stats]
    attrition = 1 - len(survivors) / len(selected)

    if not survivors:
        return {"error": "no selected wallet traded in the eval window"}

    sel_edge = sum(eval_stats[s.wallet].edge for s in survivors) / len(survivors)

    # Activity-matched null: draw the same number of wallets, from the same
    # eligible pool, matched on trade-count decile, ignoring rank-window edge.
    rng = random.Random(seed)
    pool = [s for s in ranked if s.wallet in eval_stats]
    by_activity = sorted(pool, key=lambda s: s.n_trades)
    null_means = []
    for _ in range(n_null):
        draw = rng.sample(by_activity, min(len(survivors), len(by_activity)))
        null_means.append(sum(eval_stats[s.wallet].edge for s in draw) / len(draw))
    null_means.sort()
    pct = sum(1 for m in null_means if m < sel_edge) / len(null_means)

    both = [w for w in eligible if w in eval_stats]
    rho = spearman(
        [rank_stats[w].edge for w in both],
        [eval_stats[w].edge for w in both],
    )

    med_trades = sorted(s.n_trades for s in selected)[len(selected) // 2]

    return {
        "wallets_eligible": len(eligible),
        "selected": len(selected),
        "median_track_record": med_trades,
        "underpowered": med_trades < 50,
        "selected_surviving": len(survivors),
        "attrition": attrition,
        "rank_window_edge": sum(s.edge for s in selected) / len(selected),
        "eval_window_edge": sel_edge,
        "null_median_edge": null_means[len(null_means) // 2],
        "percentile_vs_null": pct,
        "spearman_rank_vs_eval": rho,
        "n_wallets_both_windows": len(both),
    }


def format_report(r):
    if "error" in r:
        return f"Study failed: {r['error']}"
    if r["underpowered"]:
        verdict = (
            f"INCONCLUSIVE — median track record is {r['median_track_record']} "
            "trades. At that length the top decile is mostly lucky wallets even "
            "when real sharps exist, so neither a positive nor a negative result "
            "here is trustworthy. Raise min_trades."
        )
    elif r["percentile_vs_null"] >= 0.95 and r["eval_window_edge"] > 0:
        verdict = "PERSISTS — selection beats the activity-matched null"
    else:
        verdict = "NO PERSISTENCE — consistent with selecting on noise"

    return "\n".join([
        f"Eligible wallets (rank window): {r['wallets_eligible']:,}",
        f"Selected (top decile):          {r['selected']:,}",
        f"  median track record:          {r['median_track_record']} trades",
        f"  still trading in eval window: {r['selected_surviving']:,} "
        f"(attrition {r['attrition']:.0%})",
        "",
        f"Edge per $ risked, rank window: {r['rank_window_edge']:+.3f}",
        f"Edge per $ risked, eval window: {r['eval_window_edge']:+.3f}",
        f"  activity-matched null median: {r['null_median_edge']:+.3f}",
        f"  percentile vs null:           {r['percentile_vs_null']:.1%}",
        "",
        f"Spearman(rank edge, eval edge): {r['spearman_rank_vs_eval']:+.3f} "
        f"over {r['n_wallets_both_windows']:,} wallets",
        "",
        f"VERDICT: {verdict}",
    ])
