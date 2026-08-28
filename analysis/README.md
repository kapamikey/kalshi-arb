# Wallet edge study

Does ranking prediction-market wallets by past performance identify wallets that
are profitable *going forward*? That is the claim behind every "copy the top
wallets" pitch, and it is testable.

```bash
python3 analysis/test_edge.py                          # validate the rig (10 tests)
python3 analysis/run_study.py --demo --min-trades 100  # synthetic, zero edge
python3 analysis/run_study.py --demo --skilled         # synthetic, real edge
python3 analysis/run_study.py --live                   # real Polymarket data
python3 analysis/run_study.py \
    --trades-json trades.json --markets-json markets.json   # from a dump
```

Stdlib only. No numpy, no pandas.

## Method

The one thing that makes this different from the usual spreadsheet: **rank on one
time window, measure on a disjoint later one.** Ranking and measuring on the same
data selects for luck, and the more wallets you screen the more extreme the
winner looks.

Four things the naive version omits:

1. **Disjoint windows.** Rank before `split_ts`, evaluate strictly after.
2. **Edge per dollar risked**, not raw P&L — otherwise you just select whoever
   bet biggest.
3. **An activity-matched null.** Randomly drawn wallets from the same pool,
   matched on activity, ignoring past edge. Lets "the top decile made money" be
   distinguished from "active wallets made money."
4. **Attrition.** Wallets that stop trading between windows are invisible to any
   forward test, and they are exactly the ones that blew up. Reported explicitly.

P&L is exact for binary contracts: `cash_flow + final_position × resolution`.
Unresolved markets contribute only realised cash flow and are counted separately,
since valuing an open position at cost lets a wallet look flat while sitting on a
loss.

## Validation

The rig is tested against synthetic populations with known ground truth, because
a method that can't tell a skilled population from a random one has nothing to
say about a real one. Both directions are asserted:

| Population | Verdict |
|---|---|
| 9,000 wallets, **zero** edge by construction | NO PERSISTENCE ✓ |
| 9,000 wallets, **5% with real +0.35 edge** | PERSISTS ✓ |

In the zero-edge run the selected decile shows `+0.083` edge per dollar in the
rank window and `−0.024` forward. The apparent skill is entirely manufactured by
the ranking.

## The finding that matters: track record length

Varying only the minimum required track record, on a population where 5% of
wallets have large, genuinely persistent edge:

| min trades | top-decile purity | forward edge | vs. null |
|---:|---:|---:|---:|
| 10 | 19% | +0.019 | 95% |
| 25 | 28% | +0.048 | 100% |
| 50 | 37% | +0.080 | 100% |
| 100 | **59%** | **+0.101** | 100% |

(Base rate is 5%, so even the 10-trade cut enriches ~4×.)

Below roughly 50 trades the selected decile is mostly lucky wallets **even when
real sharps exist**, and forward edge collapses toward zero. A ranking built on
short track records isn't a weak signal — it's close to no signal. The study
therefore reports `INCONCLUSIVE` rather than a confident null when the median
selected track record is under 50, because at that length a negative result is
just as untrustworthy as a positive one.

This is the number that any "I ranked 14,000 wallets" claim has to answer, and
it is the number such claims never state.

## Context for a single spectacular wallet

`best_of_n_under_null()` answers: how good does the *best* of N zero-edge wallets
look? Screening thousands of candidates and reporting the winner produces a
maximum, not an estimate. A 90%-win-rate wallet found by screening 14,000 is
weak evidence of anything; the same wallet specified in advance would be strong.

## Live data

`polymarket.py` is **unverified against the live API** — every Polymarket host
(gamma-api, data-api, clob, goldsky) returns HTTP 000 from the agent container's
egress proxy, so field names come from the documented shape and have never been
exercised. Spots most likely to break are marked `FIELD`.

That's a parsing problem, not a methodology one: `edge.py` takes plain tuples and
is validated independently, so run `--live` somewhere with network access and fix
field names against a real response. Results cache to `analysis/cache/`.

If you can't run this where Polymarket is reachable, fetch the data anywhere else
and hand over the JSON — no egress needed on the analysis side:

```bash
curl 'https://data-api.polymarket.com/trades?limit=500' > trades.json
curl 'https://gamma-api.polymarket.com/markets?closed=true&limit=500' > markets.json
python3 analysis/run_study.py --trades-json trades.json --markets-json markets.json
```

The dump path is exercised end to end against synthetic data in the live API's
JSON shape, so the parser is tested even though the network call isn't. The runner
reports the parse rate and warns if more than 10% of rows are dropped — silent
field-name drift is the failure mode that would otherwise produce a confident
answer from a tenth of the data.

## What a real result would look like

If top-decile wallets genuinely persist, `percentile_vs_null` sits at ~100% with
positive forward edge and a Spearman well above zero — as in the skilled
synthetic run. If they don't, forward edge sits near zero and the percentile lands
mid-distribution.

Either answer is worth having. The second one is worth more than it looks: it is
cheap to learn here and expensive to learn by funding it.
