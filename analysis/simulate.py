"""
Synthetic wallet populations with known ground truth.

The point of this file is to validate the study rig before pointing it at real
data. If the methodology can't distinguish a population where skill exists from
one where it doesn't, its verdict on real data means nothing.

Two generators:
  - `population(skilled_frac=0.0)`  -> nobody has edge; rig must find none.
  - `population(skilled_frac=0.05)` -> 5% have real edge; rig must find it.

Stdlib only.
"""

import random

BUY = "BUY"


def population(
    n_wallets=4000,
    n_markets=800,
    skilled_frac=0.0,
    skill_edge=0.15,
    span=1000,
    seed=0,
):
    """
    Build (trades, resolutions, split_ts, skilled_set).

    Every wallet buys at the market's fair price. Unskilled wallets win exactly
    as often as the price implies — zero edge by construction. Skilled wallets
    win `skill_edge` more often than the price implies, which is a real,
    persistent advantage that a sound method must detect in BOTH windows.
    """
    rng = random.Random(seed)

    # Each market has a fair price and a resolution drawn from it.
    fair = {}
    resolved = {}
    for m in range(n_markets):
        p = rng.uniform(0.05, 0.95)
        fair[m] = p
        resolved[m] = 1.0 if rng.random() < p else 0.0

    resolutions = {}
    for m in range(n_markets):
        resolutions[(m, "YES")] = resolved[m]
        resolutions[(m, "NO")] = 1.0 - resolved[m]

    skilled = set(rng.sample(range(n_wallets), int(n_wallets * skilled_frac)))

    trades = []
    for w in range(n_wallets):
        wallet = f"0x{w:040x}"
        # Heavy-tailed activity, as in real wallet data.
        n = max(4, int(rng.paretovariate(1.3) * 10))
        for _ in range(n):
            m = rng.randrange(n_markets)
            p = fair[m]
            ts = rng.randrange(span)
            size = rng.choice([10, 25, 50, 100])

            if w in skilled:
                # Skill = knowing the true probability better than the price.
                # Take the side the resolution actually favours, `skill_edge`
                # of the time more often than chance.
                informed = rng.random() < skill_edge
                if informed:
                    want_yes = resolved[m] == 1.0
                else:
                    want_yes = rng.random() < p
            else:
                want_yes = rng.random() < p

            outcome = "YES" if want_yes else "NO"
            price = p if want_yes else 1 - p
            trades.append((wallet, m, outcome, BUY, price, size, ts))

    trades.sort(key=lambda t: t[6])
    return trades, resolutions, span // 2, {f"0x{w:040x}" for w in skilled}
