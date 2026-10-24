import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const resultsPath = resolve(root, "episodes/ep07-15-vs-30-year/results.json");
const ratesPath = resolve(
  root,
  "data/snapshots/fred-housing-2026-07-31/fred-housing-normalised.csv",
);
const ratesManifestPath = resolve(
  root,
  "data/snapshots/fred-housing-2026-07-31/manifest.json",
);
const shillerPath = resolve(
  root,
  "data/snapshots/shiller-2026-07-26/shiller-monthly.csv",
);
const shillerRawPath = resolve(
  root,
  "data/snapshots/shiller-2026-07-26/ie_data.xls",
);

function parseCsv(path) {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const keys = header.split(",");
  return lines.map((line) =>
    Object.fromEntries(
      line.split(",").map((value, index) => [keys[index], value]),
    ),
  );
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function addMonths(month, count) {
  const [year, oneBasedMonth] = month.split("-").map(Number);
  const serial = year * 12 + oneBasedMonth - 1 + count;
  return `${Math.floor(serial / 12)}-${String((serial % 12) + 1).padStart(2, "0")}`;
}

function payment(ratePercent, months) {
  const rate = ratePercent / 1200;
  return rate === 0
    ? 1 / months
    : rate / (1 - Math.pow(1 + rate, -months));
}

function hybridTerms(rate30Percent, payment15) {
  const rate = rate30Percent / 1200;
  let balance = 1;
  let totalPaid = 0;
  for (let month = 1; month <= 360; month += 1) {
    const due = balance * (1 + rate);
    const paid = Math.min(payment15, due);
    balance = due - paid;
    totalPaid += paid;
    if (balance <= 1e-12) {
      return { payoffMonth: month, totalPaid };
    }
  }
  throw new Error("Hybrid loan did not amortize within 360 months");
}

function requiredAnnualReturn(payment15, payment30) {
  const difference = payment15 - payment30;
  const growthOver180Months = payment15 / difference - 1;
  const monthly = Math.pow(growthOver180Months, 1 / 180) - 1;
  return Math.pow(1 + monthly, 12) - 1;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function investPath(factors, rate15, rate30, contributionTiming = "end") {
  const payment15 = payment(rate15, 180);
  const payment30 = payment(rate30, 360);
  const difference = payment15 - payment30;
  let portfolio15 = 0;
  let portfolio30 = 0;

  for (let month = 0; month < factors.length; month += 1) {
    const contribution15 = month >= 180 ? payment15 : 0;
    if (contributionTiming === "begin") {
      portfolio15 = (portfolio15 + contribution15) * factors[month];
      portfolio30 = (portfolio30 + difference) * factors[month];
    } else {
      portfolio15 = portfolio15 * factors[month] + contribution15;
      portfolio30 = portfolio30 * factors[month] + difference;
    }
  }

  return portfolio30 - portfolio15;
}

const results = JSON.parse(readFileSync(resultsPath, "utf8"));
const rateManifest = JSON.parse(readFileSync(ratesManifestPath, "utf8"));
const rates = parseCsv(ratesPath).map((row) => ({
  month: row.month,
  rate30: Number(row.mortgage30usPercent),
  rate15: Number(row.mortgage15usPercent),
}));
const rateByMonth = new Map(rates.map((row) => [row.month, row]));
const shiller = parseCsv(shillerPath).map((row) => ({
  month: row.date,
  cpi: Number(row.cpi),
  nominalTotalReturn: Number(row.realTotalReturnPrice) * Number(row.cpi),
}));
const shillerIndex = new Map(shiller.map((row, index) => [row.month, index]));

const checks = [];
function check(condition, label, detail = "") {
  checks.push({ ok: Boolean(condition), label, detail });
}

function near(actual, expected, tolerance, label) {
  check(
    Math.abs(actual - expected) <= tolerance,
    label,
    `actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
  );
}

// Snapshot provenance: validate only pinned inputs and manifests, never sim source.
near(
  results.meta.rateSnapshot.coverage.rows,
  rates.length,
  0,
  "rate row count matches embedded manifest",
);
check(
  results.meta.rateSnapshot.sha256 === rateManifest.sha256,
  "rate manifest identity matches results",
);
check(
  sha256(shillerRawPath) === results.meta.snapshot.sha256,
  "raw Shiller workbook hash matches results",
);

// Re-derive all 32 arithmetic rows from the standard amortisation formula.
for (const row of results.breakEven) {
  const payment15 = payment(row.rate15Percent, 180);
  const payment30 = payment(row.rate30Percent, 360);
  const hybrid = hybridTerms(row.rate30Percent, payment15);
  const prefix = `break-even ${row.rate30Percent}%/${row.rate15Percent}%`;
  near(payment15 / payment30, row.paymentRatio, 1e-12, `${prefix} payment ratio`);
  near(payment15 - payment30, row.monthlyDiffShare, 1e-12, `${prefix} monthly difference`);
  near(
    requiredAnnualReturn(payment15, payment30),
    row.requiredAnnualReturn30y,
    1e-12,
    `${prefix} required annual return`,
  );
  near(hybrid.payoffMonth, row.hybridPayoffMonths, 0, `${prefix} hybrid payoff month`);
  near(
    hybrid.totalPaid - payment15 * 180,
    row.hybridExtraCostShare,
    1e-12,
    `${prefix} hybrid extra cash cost`,
  );
}

// Validate that every completed cohort uses the pinned monthly FRED averages.
for (const cohort of results.cohorts30) {
  const pinned = rateByMonth.get(cohort.month);
  check(Boolean(pinned), `${cohort.month} exists in pinned rate snapshot`);
  if (pinned) {
    near(pinned.rate15, cohort.rate15, 1e-12, `${cohort.month} 15-year rate`);
    near(pinned.rate30, cohort.rate30, 1e-12, `${cohort.month} 30-year rate`);
  }
  const cohortHybrid = hybridTerms(cohort.rate30, payment(cohort.rate15, 180));
  near(
    cohortHybrid.payoffMonth,
    cohort.hybridPayoffMonth,
    0,
    `${cohort.month} hybrid payoff month`,
  );
}
near(
  median(results.cohorts30.map((row) => row.hybridPayoffMonth)),
  results.headline30y.medianHybridPayoffMonth,
  0,
  "median historical hybrid payoff month",
);

const independent = [];
for (const cohort of results.cohorts30) {
  const start = shillerIndex.get(cohort.month);
  const endMonth = addMonths(cohort.month, 360);
  const end = shillerIndex.get(endMonth);
  check(start !== undefined && end !== undefined, `${cohort.month} has a 360-month Shiller window`);
  if (start === undefined || end === undefined) continue;

  const factors = [];
  for (let index = start; index < end; index += 1) {
    factors.push(
      shiller[index + 1].nominalTotalReturn / shiller[index].nominalTotalReturn,
    );
  }
  const inflation = shiller[end].cpi / shiller[start].cpi;
  const realizedCagr = Math.pow(
    shiller[end].nominalTotalReturn / shiller[start].nominalTotalReturn,
    1 / 30,
  ) - 1;
  const requiredReturn = requiredAnnualReturn(
    payment(cohort.rate15, 180),
    payment(cohort.rate30, 360),
  );
  const steadyFactor = Math.pow(
    shiller[end].nominalTotalReturn / shiller[start].nominalTotalReturn,
    1 / 360,
  );

  const gapEnd = investPath(factors, cohort.rate15, cohort.rate30, "end") / inflation;
  const gapBegin = investPath(factors, cohort.rate15, cohort.rate30, "begin") / inflation;
  const steadyGapBegin =
    investPath(Array(360).fill(steadyFactor), cohort.rate15, cohort.rate30, "begin") /
    inflation;

  // Circular shifts keep all 360 observed monthly return factors exactly, including
  // their multiplicative total. They change only where that path lands relative to
  // the contribution schedule, unlike the zero-volatility steady replay.
  let rotationWins = 0;
  for (let shift = 0; shift < factors.length; shift += 1) {
    const rotated = factors.slice(shift).concat(factors.slice(0, shift));
    if (investPath(rotated, cohort.rate15, cohort.rate30, "begin") > 0) {
      rotationWins += 1;
    }
  }
  const reversedGap =
    investPath([...factors].reverse(), cohort.rate15, cohort.rate30, "begin") /
    inflation;

  independent.push({
    month: cohort.month,
    resultGap: cohort.gapShare,
    gapEnd,
    gapBegin,
    realizedCagr,
    requiredReturn,
    steadyGapBegin,
    rotationWinRate: rotationWins / factors.length,
    reversedGap,
  });
}

const endTimingMaxError = Math.max(
  ...independent.map((row) => Math.abs(row.gapEnd - row.resultGap)),
);
const beginTimingMaxError = Math.max(
  ...independent.map((row) => Math.abs(row.gapBegin - row.resultGap)),
);
check(
  beginTimingMaxError < 5e-4,
  "independent 30-year gaps reproduce with beginning-of-month contributions",
  `max error=${beginTimingMaxError}; end-of-month alternative=${endTimingMaxError}`,
);

near(
  independent.filter((row) => row.gapBegin > 0).length / independent.length,
  results.headline30y.thirtyWinRate,
  0,
  "58-window realized win rate",
);
near(
  independent.filter((row) => row.steadyGapBegin > 0).length / independent.length,
  results.headline30y.thirtyWinRateIfSteady,
  0,
  "58-window steady replay win rate",
);
near(
  median(independent.map((row) => row.realizedCagr)),
  results.headline30y.medianRealizedCagr,
  5e-5,
  "median realized CAGR headline",
);
near(
  median(independent.map((row) => row.requiredReturn)),
  results.headline30y.medianRequiredReturn,
  5e-5,
  "median required return headline",
);
near(
  median(independent.map((row) => row.gapBegin)),
  results.headline30y.medianGapShare,
  5e-5,
  "median realized gap headline",
);
near(
  median(independent.map((row) => row.gapBegin - row.steadyGapBegin)),
  results.headline30y.medianSequencePenalty,
  5e-4,
  "median sequence penalty headline",
);

const pathByMonth = new Map(results.pathVsSteady.map((row) => [row.Month, row]));
for (const row of independent) {
  const reported = pathByMonth.get(row.month);
  check(Boolean(reported), `${row.month} exists in path-vs-steady output`);
  if (!reported) continue;
  near(row.realizedCagr, reported.RealizedCagr, 5e-5, `${row.month} realized CAGR`);
  near(row.requiredReturn, reported.RequiredReturn, 5e-5, `${row.month} required return`);
  near(row.gapBegin, reported.RealizedGapShare, 5e-5, `${row.month} realized gap`);
  near(row.steadyGapBegin, reported.SteadyGapShare, 5e-5, `${row.month} steady gap`);
  near(
    row.gapBegin - row.steadyGapBegin,
    reported.SequencePenalty,
    1e-4,
    `${row.month} sequence penalty`,
  );
  check(
    (row.steadyGapBegin > 0) === reported.ThirtyWinsIfSteady,
    `${row.month} steady winner flag`,
  );
}

const rawWinningWindows = independent.filter(
  (row) => row.realizedCagr > row.requiredReturn,
).length;
const rotationRates = independent.map((row) => row.rotationWinRate);
const reverseWins = independent.filter((row) => row.reversedGap > 0).length;

const failures = checks.filter((row) => !row.ok);
const summary = {
  checks: checks.length,
  passed: checks.length - failures.length,
  failed: failures.length,
  completedWindows: independent.length,
  originalThirtyWins: independent.filter((row) => row.gapBegin > 0).length,
  endOfMonthThirtyWins: independent.filter((row) => row.gapEnd > 0).length,
  steadyThirtyWins: independent.filter((row) => row.steadyGapBegin > 0).length,
  windowsWhoseRealizedCagrClearedOwnBar: rawWinningWindows,
  endTimingMaxError,
  beginTimingMaxError,
  exactReturnReordering: {
    reverseThirtyWins: reverseWins,
    rotationWinRateMedian: median(rotationRates),
    rotationWinRateMin: Math.min(...rotationRates),
    rotationWinRateMax: Math.max(...rotationRates),
    aggregateRotationWinRate:
      rotationRates.reduce((total, value) => total + value, 0) /
      rotationRates.length,
  },
};

console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) {
  console.error("\nFAILURES");
  for (const failure of failures) {
    console.error(`- ${failure.label}: ${failure.detail}`);
  }
  process.exitCode = 1;
}
