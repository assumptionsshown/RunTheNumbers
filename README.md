# The Assumption Panel

Code and data behind the videos.

Every personal finance argument, settled with data. Assumptions on screen, code
public. If you think one of the assumptions is wrong, change it and re-run it. That
is what this repository is for.

## Why this exists

Most finance content asks you to trust the person saying it. This channel is
anonymous, so that is not on offer. What is on offer instead is that every number
in every video can be reproduced from this repository, from a dataset pinned by
date and hash, using code you can read.

Don't trust it. Re-run it.

## Episodes

| # | Question | Video | Data |
|---|---|---|---|
| 1 | Lump sum or spread it out? | [Lump Sum vs DCA: I Tested All 1,855 Months Since 1871](https://youtu.be/YV2cOHZvYcY) | `episodes/ep01-lumpsum-vs-dca/results.json` |
| 2 | What does a 1% fee actually cost, and is it ever worth it? | publishing shortly | `episodes/ep02-fees/results.json` |

Episode 2's code and results are public before its video, on purpose. Reproduce it
with the same command as episode 1, adding `--episode ep02` and pointing the output
at `episodes/ep02-fees/results.json`.

## Reproducing episode 1

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
```

`results.json` holds every number that appears on screen. The slides read from it
directly, so nothing in a video is typed by hand.

To see the slides:

```bash
node tools/serve.mjs 5173
```

then open `http://localhost:5173/render/ep01.html`.

## The result

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

## Assumptions

These decide the answer. Change any of them and the number changes.

- Real (inflation-adjusted) total return, dividends reinvested
- Base case: idle cash holds its real value (0% real). Deliberately the generous
  assumption for DCA, and a fair long-run stand-in for T-bills
- Sensitivity: idle cash earns 0% nominal, so it erodes with inflation. The lump
  sum then wins 72.0% instead of 67.2%, so the answer does not hinge on this choice
- No taxes, no transaction costs, no fund fees
- US large-cap index only (S&P Composite)
- The holding period is measured from the month of the final purchase

## Data

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
