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
    ap.add_argument("--trades-json", help="trades dump fetched elsewhere")
    ap.add_argument("--markets-json", help="markets dump fetched elsewhere")
    args = ap.parse_args()

    if args.trades_json and not args.markets_json:
        ap.error("--trades-json also needs --markets-json for resolutions")

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
    elif args.live or args.trades_json:
        import json
        import polymarket as pm

        if args.trades_json:
            with open(args.trades_json) as f:
                raw_trades = json.load(f)
            with open(args.markets_json) as f:
                raw_markets = json.load(f)
        else:
            print("Fetching Polymarket data (cached under analysis/cache/)...")
            try:
                raw_trades = pm.fetch_trades()
                raw_markets = pm.fetch_resolved_markets()
            except pm.EgressBlocked as e:
                sys.exit(
                    f"\n{e}\n\n"
                    "To run it from a dump instead:\n"
                    "  curl 'https://data-api.polymarket.com/trades?limit=500' > trades.json\n"
                    "  curl 'https://gamma-api.polymarket.com/markets?closed=true&limit=500' > markets.json\n"
                    "  python3 analysis/run_study.py --trades-json trades.json "
                    "--markets-json markets.json\n"
                )

        trades = pm.to_trades(raw_trades)
        resolutions = pm.to_resolutions(raw_markets)
        print(f"Parsed {len(trades):,}/{len(raw_trades):,} trades, "
              f"{len(resolutions):,} resolved outcomes")
        if len(raw_trades) and len(trades) / len(raw_trades) < 0.9:
            print("WARNING: >10% of trades failed to parse — check the FIELD "
                  "notes in polymarket.py before trusting this run.")
        if not trades:
            sys.exit("No trades parsed. Check the FIELD notes in polymarket.py.")
        stamps = sorted(t[6] for t in trades)
        split = stamps[len(stamps) // 2]
        label = (
            f"LIVE — {len(trades):,} trades, {len(resolutions):,} resolved outcomes"
        )
    else:
        ap.error("pass --demo, --live, or --trades-json/--markets-json")

    print(f"\n{label}")
    print(f"Split: rank window < {split} <= eval window\n")

    r = persistence_study(
        trades, resolutions, split,
        min_trades=args.min_trades, top_frac=args.top_frac,
    )
    print(format_report(r))


if __name__ == "__main__":
    main()
