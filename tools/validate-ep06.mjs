#!/usr/bin/env node
// Independent EP06 ledger reconstruction.  This deliberately does not import
// the .NET simulator: it reads only the pinned Shiller interface and compares
// a fresh JavaScript implementation with the published result/render inputs.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ep = join(root, "episodes", "ep06-four-percent-rule");
const snapshot = join(root, "data", "snapshots", "shiller-2026-07-26");

const [rawCsv, manifest, results, batch] = await Promise.all([
  readFile(join(snapshot, "shiller-monthly.csv"), "utf8"),
  readFile(join(snapshot, "manifest.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "results.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "batch.json"), "utf8").then(JSON.parse),
]);

const failures = [];
let checks = 0;
const check = (condition, message) => {
  checks += 1;
  if (!condition) failures.push(message);
};
const close = (a, b, tolerance = 1e-11) => Math.abs(a - b) <= tolerance;

// The public snapshot is the sole financial input.  The raw XLS hash is
// intentionally checked via the manifest; the normalized monthly interface is
// the one this episode says it reads at render time.
const rawHash = createHash("sha256").update(await readFile(join(snapshot, "ie_data.xls"))).digest("hex");
check(rawHash === manifest.sha256, `raw Shiller SHA-256 ${rawHash} != pinned ${manifest.sha256}`);

const lines = rawCsv.trim().split(/\r?\n/);
const columns = lines.shift().split(",");
const monthly = new Map(lines.map((line) => {
  const cells = line.split(",");
  return [cells[0], Object.fromEntries(columns.map((name, i) => [name, name === "date" ? cells[i] : Number(cells[i])]))];
}));
check(monthly.size === manifest.months, `monthly rows ${monthly.size} != manifest ${manifest.months}`);

const january = new Map();
for (const row of monthly.values()) {
  if (row.date.endsWith("-01")) january.set(Number(row.date.slice(0, 4)), row);
}

// This is a standalone statement of the disclosed proxy: a ten-year par bond's
// Macaulay duration at the starting GS10 yield, converted to modified duration;
// coupon yield minus the price move; then deflated by the next January CPI.
// It is separate code and a separate data read from Retirement.cs.
function yearReturn(year) {
  const start = january.get(year);
  const end = january.get(year + 1);
  if (!start || !end) return null;
  const stockReal = end.realTotalReturnPrice / start.realTotalReturnPrice - 1;
  const inflation = end.cpi / start.cpi - 1;
  const y0 = start.gs10 / 100;
  const y1 = end.gs10 / 100;
  // Par bond: the annuity factor IS the modified duration. Corrected 2026-10-09
  // (Claude): this used to divide it by (1 + y0) again, mirroring the same slip
  // in Retirement.cs, which is why the two agreed while both were wrong.
  const modified = (1 - (1 + y0) ** -10) / y0;
  const bondNominal = y0 - modified * (y1 - y0);
  const bondReal = (1 + bondNominal) / (1 + inflation) - 1;
  return { year, stockReal, bondReal };
}

const years = [];
for (let year = results.meta.firstYear; year <= results.meta.lastYear; year += 1) {
  const row = yearReturn(year);
  if (row) years.push(row);
}
check(years.length === 155, `annual return rows ${years.length} != 155`);
check(years.every((row, i) => row.year === results.meta.firstYear + i), "annual January rows are not contiguous");

function run(startYear, rate, horizon, stockShare, reverse = false) {
  const start = years.findIndex((row) => row.year === startYear);
  if (start < 0 || start + horizon > years.length) throw new Error(`no full ${horizon}-year window for ${startYear}`);
  const window = years.slice(start, start + horizon);
  if (reverse) window.reverse();
  let balance = 1;
  let depletedInYear = null;
  const path = [balance];
  for (let i = 0; i < horizon; i += 1) {
    balance -= rate;
    if (balance <= 0) {
      depletedInYear ??= window[i].year;
      balance = 0;
      while (path.length <= horizon) path.push(0);
      break;
    }
    const r = window[i];
    balance *= 1 + stockShare * r.stockReal + (1 - stockShare) * r.bondReal;
    path.push(balance);
  }
  return { startYear, survived: depletedInYear === null, depletedInYear, finalMultiple: balance, path };
}

function allRuns(rate, horizon, stockShare) {
  return years.slice(0, years.length - horizon + 1).map((row) => run(row.year, rate, horizon, stockShare));
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function summary(rate, horizon, stockShare) {
  const runs = allRuns(rate, horizon, stockShare);
  const failuresHere = runs.filter((row) => !row.survived).length;
  return {
    cohorts: runs.length,
    failures: failuresHere,
    successRate: 1 - failuresHere / runs.length,
    medianFinalMultiple: median(runs.map((row) => row.finalMultiple)),
    runs,
  };
}

const base = { rate: 0.04, horizon: results.baseCase.horizonYears, stockShare: results.baseCase.stockShare };
const baseSummary = summary(base.rate, base.horizon, base.stockShare);
const baseRuns = baseSummary.runs;

// The renderer's 126 cohort paths are a much stronger check than its rounded
// timeline labels: each is 31 independently recomputed balances.
check(batch.cohorts.length === baseRuns.length, `batch cohorts ${batch.cohorts.length} != ${baseRuns.length}`);
for (const expected of baseRuns) {
  const actual = batch.cohorts.find((row) => row.startYear === expected.startYear);
  check(Boolean(actual), `batch is missing ${expected.startYear}`);
  if (!actual) continue;
  check(actual.survived === expected.survived, `${expected.startYear}: survived ${actual.survived} != ${expected.survived}`);
  check(actual.depletedInYear === expected.depletedInYear,
    `${expected.startYear}: depleted ${actual.depletedInYear} != ${expected.depletedInYear}`);
  check(close(actual.finalMultiple, expected.finalMultiple),
    `${expected.startYear}: final ${actual.finalMultiple} != ${expected.finalMultiple}`);
  check(actual.path.length === expected.path.length, `${expected.startYear}: path length ${actual.path.length} != ${expected.path.length}`);
  for (let i = 0; i < Math.min(actual.path.length, expected.path.length); i += 1) {
    check(close(actual.path[i], expected.path[i]), `${expected.startYear}: path[${i}] ${actual.path[i]} != ${expected.path[i]}`);
  }
}

function compareSummary(label, actual, expected) {
  const cohorts = expected.Cohorts ?? expected.cohorts;
  const failed = expected.Failures ?? expected.failures;
  const success = expected.SuccessRate ?? expected.successRate;
  const medianResult = expected.MedianFinalMultiple ?? expected.medianFinalMultiple;
  if (cohorts !== undefined) check(actual.cohorts === cohorts, `${label}: cohorts ${actual.cohorts} != ${cohorts}`);
  if (failed !== undefined) check(actual.failures === failed, `${label}: failures ${actual.failures} != ${failed}`);
  if (success !== undefined) check(close(actual.successRate, success), `${label}: success rate ${actual.successRate} != ${success}`);
  if (medianResult !== undefined) check(close(actual.medianFinalMultiple, medianResult), `${label}: median ${actual.medianFinalMultiple} != ${medianResult}`);

  // Claude, 2026-09-06: the sweeps grew a per-detent finalMultiples array so the
  // dials could MOVE the population instead of printing a rate beside it. Those
  // arrays are where every mark sits while a dial is turning, and the aggregate
  // checks above cannot see them: a detent can report the right failure count
  // and still place the marks wrongly. Reconstructed here from the same raw
  // series as everything else, so the addition does not weaken the rule that
  // this file never imports the simulation.
  const finals = expected.finalMultiples;
  if (finals !== undefined) {
    check(finals.length === actual.runs.length,
      `${label}: ${finals.length} final multiples for ${actual.runs.length} cohorts`);
    for (let i = 0; i < Math.min(finals.length, actual.runs.length); i += 1) {
      check(close(finals[i], actual.runs[i].finalMultiple),
        `${label}: final[${i}] ${finals[i]} != ${actual.runs[i].finalMultiple}`);
    }
  }
}

for (const expected of results.byRate) compareSummary(`rate ${expected.Rate}`, summary(expected.Rate, expected.Horizon, expected.StockShare), expected);
for (const expected of batch.rateSweep) compareSummary(`rate sweep ${expected.rate}`, summary(expected.rate, base.horizon, base.stockShare), expected);
for (const expected of results.byHorizon) compareSummary(`horizon ${expected.Horizon}`, summary(expected.Rate, expected.Horizon, expected.StockShare), expected);
for (const expected of results.byMix) compareSummary(`mix ${expected.StockShare}`, summary(expected.Rate, expected.Horizon, expected.StockShare), expected);
for (const expected of batch.mixSweep) compareSummary(`mix sweep ${expected.stockShare}`, summary(base.rate, base.horizon, expected.stockShare), expected);

// Safe-rate boundary and the reversed 1964 path are both narration claims.
const safe = summary(results.safeRate.rate, base.horizon, base.stockShare);
check(safe.failures === 0, `safe rate ${results.safeRate.rate} still has ${safe.failures} failures`);
check(summary(results.safeRate.rate + 1e-8, base.horizon, base.stockShare).failures > 0,
  "reported safe rate is not the highest all-surviving boundary");
const sequence = run(batch.sequence.startYear, base.rate, base.horizon, base.stockShare, true);
check(batch.sequence.forwardPath.length === baseRuns.find((row) => row.startYear === batch.sequence.startYear).path.length,
  "forward sequence path length differs from cohort path");
for (let i = 0; i < sequence.path.length; i += 1) {
  check(close(sequence.path[i], batch.sequence.reversedPath[i]),
    `reversed 1964 path[${i}] ${batch.sequence.reversedPath[i]} != ${sequence.path[i]}`);
}
check(close(sequence.finalMultiple, results.sequenceRisk.reversedFinalMultiple),
  `reversed final ${sequence.finalMultiple} != ${results.sequenceRisk.reversedFinalMultiple}`);

// These are the report's public claims, independently tied back to the rebuilt ledger.
check(baseSummary.cohorts === 126, `headline cohorts ${baseSummary.cohorts} != 126`);
check(baseSummary.failures === 6, `headline failures ${baseSummary.failures} != 6`);
check(close(baseSummary.successRate, 120 / 126), `headline success ${baseSummary.successRate} != 120/126`);
check(baseRuns.filter((row) => !row.survived).map((row) => row.startYear).join(",") === "1964,1965,1966,1967,1968,1969",
  "the six failed cohorts are not 1964 through 1969");

console.log(`${checks - failures.length}/${checks} checks pass`);
if (failures.length) {
  console.log(`FAIL — ${failures.length} mismatches`);
  for (const message of failures.slice(0, 40)) console.log(`  ${message}`);
  if (failures.length > 40) console.log(`  ... ${failures.length - 40} more`);
  process.exitCode = 1;
} else {
  console.log("PASS — EP06 raw-data reconstruction matches results and renderer inputs");
}
