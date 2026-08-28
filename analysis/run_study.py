"""
Run the wallet-edge study.

    python3 analysis/run_study.py --demo              # synthetic, no network
    python3 analysis/run_study.py --demo --skilled    # synthetic WITH real edge
    python3 analysis/run_study.py --live              # real Polymarket data

--live needs egress to gamma-api.polymarket.com and data-api.polymarket.com,
which the agent container does not have. Run it somewhere that does.
"""

import argparse
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from edge import format_report, persistence_study  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="fetch real Polymarket data")
    ap.add_argument("--demo", action="store_true", help="run on synthetic data")
    ap.add_argument("--skilled", action="store_true",
                    help="demo only: seed 5%% of wallets with genuine edge")
    ap.add_argument("--min-trades", type=int, default=50,
                    help="minimum rank-window track record (default 50)")
    ap.add_argument("--top-frac", type=float, default=0.10)
    args = ap.parse_args()

    if args.demo:
        from simulate import population
        trades, resolutions, split, skilled = population(
            n_wallets=9000,
            skilled_frac=0.05 if args.skilled else 0.0,
            skill_edge=0.35,
            seed=5,
        )
        label = (
            "SYNTHETIC — 5% of wallets have genuine +0.35 edge"
            if args.skilled else
            "SYNTHETIC — every wallet has mathematically zero edge"
        )
    elif args.live:
        import polymarket as pm
        print("Fetching Polymarket data (cached under analysis/cache/)...")
        raw_trades = pm.fetch_trades()
        raw_markets = pm.fetch_resolved_markets()
        trades = pm.to_trades(raw_trades)
        resolutions = pm.to_resolutions(raw_markets)
        if not trades:
            sys.exit("No trades parsed. Check the FIELD notes in polymarket.py.")
        stamps = sorted(t[6] for t in trades)
        split = stamps[len(stamps) // 2]
        label = (
            f"LIVE — {len(trades):,} trades, {len(resolutions):,} resolved outcomes"
        )
    else:
        ap.error("pass --demo or --live")

    print(f"\n{label}")
    print(f"Split: rank window < {split} <= eval window\n")

    r = persistence_study(
        trades, resolutions, split,
        min_trades=args.min_trades, top_frac=args.top_frac,
    )
    print(format_report(r))


if __name__ == "__main__":
    main()
