"""
Validation for the study rig.

    python3 analysis/test_edge.py

Two tests carry the weight:
  - a population where nobody has edge must NOT show persistence
  - a population where 5% genuinely do must show it

A method that only passes the second is a method that finds edge everywhere.
"""

import sys
import unittest

sys.path.insert(0, __file__.rsplit("/", 1)[0])

from edge import (  # noqa: E402
    format_report, persistence_study, realized_pnl, spearman, wallet_stats,
)
from simulate import population  # noqa: E402


class TestPnL(unittest.TestCase):
    def test_winning_buy_held_to_resolution(self):
        # Buy 100 shares at 30c, resolves YES -> pay $30, receive $100.
        trades = [("w", 1, "YES", "BUY", 0.30, 100, 0)]
        pnl, _ = realized_pnl(trades, {(1, "YES"): 1.0})
        self.assertAlmostEqual(pnl[("w", 1, "YES")], 70.0)

    def test_losing_buy_held_to_resolution(self):
        trades = [("w", 1, "YES", "BUY", 0.30, 100, 0)]
        pnl, _ = realized_pnl(trades, {(1, "YES"): 0.0})
        self.assertAlmostEqual(pnl[("w", 1, "YES")], -30.0)

    def test_sold_before_resolution(self):
        # Buy 100 @ 30c, sell 100 @ 80c. Flat at resolution, +$50 regardless.
        trades = [
            ("w", 1, "YES", "BUY", 0.30, 100, 0),
            ("w", 1, "YES", "SELL", 0.80, 100, 1),
        ]
        for outcome in (0.0, 1.0):
            pnl, _ = realized_pnl(trades, {(1, "YES"): outcome})
            self.assertAlmostEqual(pnl[("w", 1, "YES")], 50.0)

    def test_unresolved_market_is_flagged(self):
        trades = [("w", 1, "YES", "BUY", 0.30, 100, 0)]
        _, unresolved = realized_pnl(trades, {})
        self.assertEqual(unresolved, 1)

    def test_edge_is_per_dollar_not_raw_pnl(self):
        # A whale with worse edge must not outrank a small sharp wallet.
        whale = [("whale", 1, "YES", "BUY", 0.50, 10_000, 0)]
        small = [("small", 2, "YES", "BUY", 0.50, 10, 0)]
        stats = wallet_stats(whale + small, {(1, "YES"): 1.0, (2, "YES"): 1.0})
        self.assertGreater(stats["whale"].pnl, stats["small"].pnl)
        self.assertAlmostEqual(stats["whale"].edge, stats["small"].edge)


class TestSpearman(unittest.TestCase):
    def test_perfect_and_inverse(self):
        self.assertAlmostEqual(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1.0)


class TestPersistence(unittest.TestCase):
    def test_no_edge_population_shows_no_persistence(self):
        """The critical test: pure noise must not read as skill."""
        trades, res, split, _ = population(n_wallets=9000, skilled_frac=0.0, seed=1)
        r = persistence_study(trades, res, split, min_trades=100, seed=1)

        # Selected wallets looked strongly profitable in the rank window...
        self.assertGreater(r["rank_window_edge"], 0.10)
        # ...and none of it carries forward.
        self.assertLess(abs(r["spearman_rank_vs_eval"]), 0.10)
        self.assertLess(r["percentile_vs_null"], 0.95)

    def test_real_edge_population_is_detected(self):
        """The rig must not be blind — real skill has to show up."""
        trades, res, split, _ = population(
            n_wallets=9000, skilled_frac=0.05, skill_edge=0.35, seed=5
        )
        r = persistence_study(trades, res, split, min_trades=100, seed=5)

        self.assertGreater(r["spearman_rank_vs_eval"], 0.10)
        self.assertGreater(r["percentile_vs_null"], 0.95)
        self.assertGreater(r["eval_window_edge"], 0)

    def test_short_track_records_are_flagged_not_reported(self):
        """
        The finding worth keeping: with a 10-trade minimum, a population with
        REAL edge is indistinguishable from one without. The rig must refuse to
        call it either way rather than reporting a confident null.
        """
        trades, res, split, _ = population(
            n_wallets=9000, skilled_frac=0.05, skill_edge=0.35, seed=5
        )
        r = persistence_study(trades, res, split, min_trades=10, seed=5)

        self.assertTrue(r["underpowered"])
        self.assertIn("INCONCLUSIVE", format_report(r))

    def test_attrition_is_reported(self):
        trades, res, split, _ = population(skilled_frac=0.0, seed=3)
        r = persistence_study(trades, res, split, min_trades=10, seed=3)
        self.assertIn("attrition", r)
        self.assertGreaterEqual(r["attrition"], 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
