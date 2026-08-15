# The Assumption Panel

Backtests of common personal finance arguments, with the dataset pinned by hash,
the assumptions written down, and every published number reproducible from this
repository with two commands.

Four questions are answered so far: rent versus buy across 241 US metros, lump sum
versus dollar-cost averaging on every start month since 1871, what a 1% fee costs
over 30 years, and what happens if you only ever buy at a record high.

Each one is also a video, linked in the table below, but the videos are downstream.
Every number on screen is read from a `results.json` in this repo, so nothing is
typed by hand and anything you disagree with can be changed and re-run.

## Why this exists

Most finance content asks you to trust the person saying it. The channel is
anonymous, so that is not on offer. What is on offer instead is that every number
can be reproduced from this repository, from a dataset pinned by date and hash,
using code you can read.

Don't trust it. Re-run it.

## Episodes

| # | Question | Headline result | Video | Data |
|---|---|---|---|---|
| 4 | Which numbers flip rent versus buy? | Buying won 81.9% of 9,399 five-year runs, or 31.0% with one input changed | [Rent vs Buy](https://youtu.be/_AazljGWkgc) | `episodes/ep04-rent-vs-buy/results.json` |
| 3 | What if you only ever bought at the market top? | It cost about 10% against buying on any day | [Buying at the top](https://youtu.be/X28aftmVfvM) | `episodes/ep03-buying-at-the-top/results.json` |
| 2 | What does a 1% fee actually cost? | More than panic selling every crash for 30 years | [Fees](https://youtu.be/-v4_SQQyTNc) | `episodes/ep02-fees/results.json` |
| 1 | Lump sum or spread it out? | Lump sum won 67.2% of 1,855 start months | [Lump sum vs DCA](https://youtu.be/YV2cOHZvYcY) | `episodes/ep01-lumpsum-vs-dca/results.json` |

## Episode 4: rent versus buy

9,399 five-year comparisons across 241 matched US metros, 2018-01 through 2026-03.
The comparison gives renter and buyer the same starting cash, invests whichever
household spends less that month, sells the home at the end, clears the mortgage
and compares total wealth.

Under the base case buying won **81.9%**. That figure is close to meaningless on
its own, which is the actual finding:

- Change only maintenance, from 1% of value per year to 4% for an older home, and
  81.9% becomes **31.0%**. One input, same data, opposite advice.
- Swap the whole holding-cost bundle between its cited low and high cases and it
  runs **91.7% to 23.7%**.
- Hold two years instead of five and it is **41.6%**. Time does more work than the
  mortgage rate does.
- It is not a national answer at all. Houston 100%, Honolulu 0%.

The portable version is three numbers: how long you stay, one year of comparable
rent divided by the purchase price, and the recurring cost of tax plus insurance
plus maintenance.

**Assumptions.** 20% down, 30-year fixed with no refinance, 1% property tax, 0.5%
insurance, 1% maintenance, 2.5% purchase and 7% selling cost, no federal tax
benefit in the base case. The synthetic break-even table uses 3% home growth, 3%
rent growth and 7% market return. Ranges and sources are in
`episodes/ep04-rent-vs-buy/`.

**Limits, in the order I would attack them.** Rent is Zillow ZORI and home value is
Zillow ZHVI: these are modeled typical values for a metro, **not the same physical
house**, and that is the weakest joint in the model. The ZORI era is short and
contains an unusual housing cycle. Start months overlap and metros move together,
so the effective sample is far smaller than 9,399.

**Data.** Zillow ZORI and ZHVI, FHFA quarterly HPI, mortgage rates and CPI from
FRED, market returns from the pinned Shiller series. Zillow metros do not map
cleanly onto FHFA's: 367 match whole MSAs, but 13 are split into divisions,
including several of the largest markets, and those are excluded rather than paired
against one division's index. `CPIAUCSL` has an official blank at 2025-10 from the
lapse in appropriations and is left blank rather than interpolated.

As a construction check the whole thing re-runs on FHFA's quarterly HPI instead of
ZHVI's monthly path. The two agree on **92.1%** of cases.

`node tools/validate-ep04.mjs` reproduces every published number without reading
the simulation source: 2,234 of 2,234 checks.

## Reproducing the episodes

Requires [Node.js](https://nodejs.org) 22 or newer and the
[.NET SDK](https://dotnet.microsoft.com/download) 9 or newer. Nothing else. There
are no npm packages to install, on purpose: asking you to verify a result should
not also mean asking you to trust a dependency tree.

```bash
# Rebuild the pinned dataset from source (optional, it is already committed)
node tools/build-shiller-snapshot.mjs

# Check the dataset against an independent source
node tools/validate-shiller.mjs data/snapshots/shiller-2026-07-26

# Run the simulation
dotnet run --project src/RunTheNumbers.Sim -- \
  data/snapshots/shiller-2026-07-26 \
  episodes/ep01-lumpsum-vs-dca/results.json

# Episode 2
dotnet run --project src/RunTheNumbers.Sim -- \
  data/snapshots/shiller-2026-07-26 \
  episodes/ep02-fees/results.json \
  --episode ep02

# Episode 3
dotnet run --project src/RunTheNumbers.Sim -- \
  data/snapshots/shiller-2026-07-26 \
  episodes/ep03-buying-at-the-top/results.json \
  --episode ep03

# Episode 4
dotnet run --project src/RunTheNumbers.Sim -- \
  data/snapshots/shiller-2026-07-26 \
  episodes/ep04-rent-vs-buy/results.json \
  --episode ep04

# Independently reproduce and compare all episode 4 result fields
node tools/validate-ep04.mjs
```

`results.json` holds every number that appears on screen. The slides read from it
directly, so nothing in a video is typed by hand.

To see the slides:

```bash
node tools/serve.mjs 5173
```

then open `http://localhost:5173/render/ep01.html`, `render/ep02.html`,
`render/ep03.html`, or `render/ep04.html`.

## Episode 1: lump sum versus dollar-cost averaging

Investing a lump sum immediately beat spreading it over 12 months in **67.2%** of
1,855 starting months since 1871.

Three findings that matter more than the headline:

- **The holding period is irrelevant.** After the final purchase both portfolios
  own the same asset, so the outcome is fixed then and never changes. Measured
  drift across every horizon tested: 2.2e-16, which is floating-point rounding.
- **The drip's better worst case is real but short-lived.** It shows at one and two
  years and cannot be distinguished from noise past three, while its cost is
  charged at every horizon.
- **In two of the eight worst starting months on record, the drip made the outcome
  worse.** Both were 1998, the two highest starting valuations in that group.

### Episode 1 assumptions

These decide the answer. Change any of them and the number changes.

- Real (inflation-adjusted) total return, dividends reinvested
- Base case: idle cash holds its real value (0% real). Deliberately the generous
  assumption for DCA, and a fair long-run stand-in for T-bills
- Sensitivity: idle cash earns 0% nominal, so it erodes with inflation. The lump
  sum then wins 72.0% instead of 67.2%, so the answer does not hinge on this choice
- No taxes, no transaction costs, no fund fees
- US large-cap index only (S&P Composite)
- The holding period is measured from the month of the final purchase

### Episode 1 data

Robert Shiller's monthly US stock market dataset, 1871-01 to 2026-06, from
[shillerdata.com](https://shillerdata.com).

Two things worth knowing if you go looking for this data yourself:

- The copy at `econ.yale.edu/~shiller/data/ie_data.xls` is a **stale mirror**,
  frozen around 2023-09 as of this writing. Use shillerdata.com.
- The `Date` column is a float, so October 2025 is stored as `2025.1` and is
  indistinguishable from January once parsed. The month has to come from the
  `Date Fraction` column instead. `tools/build-shiller-snapshot.mjs` derives it
  that way and cross-checks it against the strict monthly sequence.

The snapshot in `data/snapshots/` is pinned by date with a sha256 in its
`manifest.json`. Simulations read the snapshot, never the network, so a result
published months ago still reproduces exactly.

`tools/validate-shiller.mjs` checks the parsed data against sources that share none
of its code: CPI against FRED's `CPIAUCNS` series across 1,361 months, plus
arithmetic checks on long-run real return and the 1929-33 drawdown.

## Repository layout

```
tools/       data pipeline, capture, and assembly (Node, no dependencies)
  lib/cfb.mjs, lib/biff.mjs   hand-written reader for legacy .xls
  lib/cdp.mjs                 frame capture over the DevTools Protocol
src/         simulations (.NET)
render/      slides and animations, plain HTML/SVG/canvas
data/        pinned dataset snapshots
episodes/    per-episode simulation output
```

## How this is made

Most of the code here was written by an AI coding agent (Claude), directed by a
human. That is stated plainly because a channel whose entire pitch is "we show you
the assumptions" cannot then be quiet about how the work is produced.

What that does and does not mean:

- **The agent wrote most of the tooling and the simulation code.** The `.xls`
  reader, the capture pipeline, the chart rendering, the assembly step.
- **A human decides which questions get asked, which assumptions the base case
  uses, and what may be claimed on screen.** Those are the choices that determine
  whether a result is honest, and they are not delegated.
- **Neither of those is a reason to trust the output.** It is a reason to check it.
  The dataset is pinned and hashed, the loader is cross-validated against sources
  that share none of its code, and every number in every video is read from
  `results.json` rather than typed. Whoever or whatever wrote a line of code here,
  the arithmetic either reproduces on your machine or it does not.

If you find a bug that changes a published number, open an issue. A correction is
worth more to this project than a clean record.

## A note on what is not here

The videos are produced from a private working repository that also holds scripts,
drafts and production notes. This repository is a one-way mirror of the parts that
let you check the work. It is not a fork and does not share history.

## Licence

MIT. Take the pipeline, point it at your own question.
