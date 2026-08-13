// Independent reference calculations for episode 4: rent versus buy.
//
//   node tools/validate-ep04.mjs
//   node tools/validate-ep04.mjs --json
//
// This deliberately does not import or inspect the simulation. It rebuilds the
// monthly cash-flow ledger from the pinned normalised CSVs and compares that
// independent result with episodes/ep04-rent-vs-buy/results.json.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const root = join(import.meta.dirname, "..");
const housingDir = resolve(
  root,
  argOf("--housing") ?? "data/snapshots/housing-metro-crosswalk-2026-08-01",
);
const ratesDir = resolve(
  root,
  argOf("--rates") ?? "data/snapshots/fred-housing-2026-07-31",
);
const shillerDir = resolve(
  root,
  argOf("--shiller") ?? "data/snapshots/shiller-2026-07-26",
);
const resultsPath = resolve(
  root,
  argOf("--results") ?? "episodes/ep04-rent-vs-buy/results.json",
);
const jsonOnly = args.includes("--json");

const parseCsvLine = (line) => {
  const values = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
};

const parseCsv = (path) => {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const fields = parseCsvLine(header);
  return lines.map((line) =>
    Object.fromEntries(fields.map((field, i) => [field, parseCsvLine(line)[i]])),
  );
};

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const monthNumber = (date) => {
  const [year, month] = date.split("-").map(Number);
  return year * 12 + month - 1;
};
const monthAt = (number) =>
  `${Math.floor(number / 12)}-${String((number % 12) + 1).padStart(2, "0")}`;
const monthsBetween = (start, end) => monthNumber(end) - monthNumber(start);

const percentile = (sorted, p) => {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

const summarise = (runs, holdYears, cohortMonths) => {
  const sorted = runs.map((run) => run.gapShare).sort((a, b) => a - b);
  return {
    holdYears,
    runs: runs.length,
    cohortMonths,
    buyWinRate: runs.filter((run) => run.gapShare > 0).length / runs.length,
    medianGapShare: percentile(sorted, 0.5),
    p10GapShare: percentile(sorted, 0.1),
    p90GapShare: percentile(sorted, 0.9),
  };
};

const housingManifest = JSON.parse(
  readFileSync(join(housingDir, "manifest.json"), "utf8"),
);
const ratesManifest = JSON.parse(readFileSync(join(ratesDir, "manifest.json"), "utf8"));
const shillerManifest = JSON.parse(
  readFileSync(join(shillerDir, "manifest.json"), "utf8"),
);
const episode = JSON.parse(readFileSync(resultsPath, "utf8"));

const metroRows = parseCsv(join(housingDir, "metros.csv"));
const zoriRows = parseCsv(join(housingDir, "zori-normalised.csv"));
const zhviRows = parseCsv(join(housingDir, "zhvi-normalised.csv"));
const fhfaRows = parseCsv(join(housingDir, "fhfa-hpi-normalised.csv"));
const rateRows = parseCsv(join(ratesDir, "fred-housing-normalised.csv"));
const shillerRows = parseCsv(join(shillerDir, "shiller-monthly.csv"));

const groupBy = (rows, key) => {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
};

const zoriByMetro = groupBy(zoriRows, "zillow_region_id");
const zhviByMetro = groupBy(zhviRows, "zillow_region_id");
const fhfaByCbsa = groupBy(fhfaRows, "fhfa_cbsa");
const ratesByMonth = new Map(rateRows.map((row) => [row.month, row]));
const marketByMonth = new Map(
  shillerRows.map((row) => [
    row.date,
    Number(row.realTotalReturnPrice) * Number(row.cpi),
  ]),
);

const windowStart = episode.meta.window.start;
const windowEnd = episode.meta.window.end;
const windowMonths = monthsBetween(windowStart, windowEnd) + 1;
const requiredMonths = Array.from({ length: windowMonths }, (_, i) =>
  monthAt(monthNumber(windowStart) + i),
);

const rowsInWindow = (rows, periodField, start = windowStart, end = windowEnd) =>
  rows.filter((row) => row[periodField] >= start && row[periodField] <= end);
const hasEveryMonth = (rows, periodField) => {
  const present = new Set(rowsInWindow(rows, periodField).map((row) => row[periodField]));
  return requiredMonths.every((month) => present.has(month));
};
const quarterOf = (month) =>
  `${month.slice(0, 4)}Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;
const requiredQuarters = [...new Set(requiredMonths.map(quarterOf))];

const metadataByRegion = new Map(
  metroRows
    .filter((row) => row.match_status === "matched")
    .map((row) => [row.zillow_region_id, row]),
);

const panel = [...metadataByRegion.entries()]
  .filter(([regionId, meta]) => {
    const zori = zoriByMetro.get(regionId) ?? [];
    const zhvi = zhviByMetro.get(regionId) ?? [];
    const fhfa = fhfaByCbsa.get(meta.fhfa_cbsa) ?? [];
    const fhfaPeriods = new Set(fhfa.map((row) => row.period));
    return (
      hasEveryMonth(zori, "period") &&
      hasEveryMonth(zhvi, "period") &&
      requiredQuarters.every((quarter) => fhfaPeriods.has(quarter))
    );
  })
  .map(([regionId, meta]) => {
    const zori = new Map(
      rowsInWindow(zoriByMetro.get(regionId), "period").map((row) => [
        row.period,
        Number(row.zori_usd_month),
      ]),
    );
    const zhvi = new Map(
      rowsInWindow(zhviByMetro.get(regionId), "period").map((row) => [
        row.period,
        Number(row.zhvi_usd),
      ]),
    );
    const fhfa = new Map(
      (fhfaByCbsa.get(meta.fhfa_cbsa) ?? []).map((row) => [
        row.period,
        Number(row.hpi_all_transactions_nsa),
      ]),
    );
    return { regionId: Number(regionId), meta, zori, zhvi, fhfa };
  })
  .sort((a, b) => Number(a.meta.zillow_size_rank) - Number(b.meta.zillow_size_rank));

for (const month of requiredMonths) {
  if (!Number.isFinite(Number(ratesByMonth.get(month)?.mortgage30usPercent))) {
    throw new Error(`missing 30-year mortgage rate at ${month}`);
  }
  if (!Number.isFinite(marketByMonth.get(month))) {
    throw new Error(`missing market total-return level at ${month}`);
  }
}

const payment = (principal, annualRate) => {
  const monthlyRate = annualRate / 12;
  return (
    (principal * monthlyRate * (1 + monthlyRate) ** 360) /
    ((1 + monthlyRate) ** 360 - 1)
  );
};

const runLedger = ({ metro, startMonth, holdYears, assumptions, pricePath = "zhvi" }) => {
  const startIndex = monthNumber(startMonth);
  const months = holdYears * 12;
  const startPrice = metro.zhvi.get(startMonth);
  const principal = startPrice * (1 - assumptions.downPct);
  const annualRate = Number(ratesByMonth.get(startMonth).mortgage30usPercent) / 100;
  const monthlyPayment = payment(principal, annualRate);
  let balance = principal;
  let buyerPortfolio = 0;
  let renterPortfolio = startPrice * (assumptions.downPct + assumptions.buyCost);
  const startHpi = metro.fhfa.get(quarterOf(startMonth));
  const homeValueAt = (month) =>
    pricePath === "fhfa"
      ? startPrice * (metro.fhfa.get(quarterOf(month)) / startHpi)
      : metro.zhvi.get(month);

  for (let i = 0; i < months; i++) {
    const month = monthAt(startIndex + i);
    const nextMonth = monthAt(startIndex + i + 1);
    const marketGrowth = marketByMonth.get(nextMonth) / marketByMonth.get(month);
    buyerPortfolio *= marketGrowth;
    renterPortfolio *= marketGrowth;

    const interest = balance * (annualRate / 12);
    balance -= monthlyPayment - interest;

    const currentValue = homeValueAt(nextMonth);
    const ownerCosts =
      (currentValue *
        (assumptions.propertyTax + assumptions.insurance + assumptions.maintenance)) /
      12;
    const buyerCash = monthlyPayment + ownerCosts;
    const renterCash = metro.zori.get(nextMonth);
    if (buyerCash > renterCash) renterPortfolio += buyerCash - renterCash;
    else buyerPortfolio += renterCash - buyerCash;
  }

  const exitMonth = monthAt(startIndex + months);
  const buyerWealth =
    homeValueAt(exitMonth) * (1 - assumptions.sellCost) -
    balance +
    buyerPortfolio;
  const renterWealth = renterPortfolio;
  return {
    regionId: metro.regionId,
    metro: metro.meta.zillow_metro_name,
    state: metro.meta.zillow_primary_state,
    sizeRank: Number(metro.meta.zillow_size_rank),
    month: startMonth,
    ratePercent: annualRate * 100,
    startPrice,
    startRentYield: (metro.zori.get(startMonth) * 12) / startPrice,
    buyerWealth,
    renterWealth,
    gapShare: (buyerWealth - renterWealth) / startPrice,
  };
};

const base = {
  downPct: 0.2,
  propertyTax: 0.01,
  insurance: 0.005,
  maintenance: 0.01,
  buyCost: 0.025,
  sellCost: 0.07,
};

const calculateHold = (holdYears, assumptions = base, pricePath = "zhvi") => {
  const cohortMonths = windowMonths - holdYears * 12;
  const starts = requiredMonths.slice(0, cohortMonths);
  const runs = panel.flatMap((metro) =>
    starts.map((startMonth) =>
      runLedger({ metro, startMonth, holdYears, assumptions, pricePath }),
    ),
  );
  return { runs, summary: summarise(runs, holdYears, cohortMonths) };
};

const buildPanelForWindow = (start, end) => {
  const count = monthsBetween(start, end) + 1;
  const months = Array.from({ length: count }, (_, i) => monthAt(monthNumber(start) + i));
  const quarters = [...new Set(months.map(quarterOf))];
  const complete = (rows) => {
    const periods = new Set(
      rows.filter((row) => row.period >= start && row.period <= end).map((row) => row.period),
    );
    return months.every((month) => periods.has(month));
  };
  const metros = [...metadataByRegion.entries()]
    .filter(([regionId, meta]) => {
      const hpiPeriods = new Set(
        (fhfaByCbsa.get(meta.fhfa_cbsa) ?? []).map((row) => row.period),
      );
      return (
        complete(zoriByMetro.get(regionId) ?? []) &&
        complete(zhviByMetro.get(regionId) ?? []) &&
        quarters.every((quarter) => hpiPeriods.has(quarter))
      );
    })
    .map(([regionId, meta]) => ({
      regionId: Number(regionId),
      meta,
      zori: new Map(
        (zoriByMetro.get(regionId) ?? [])
          .filter((row) => row.period >= start && row.period <= end)
          .map((row) => [row.period, Number(row.zori_usd_month)]),
      ),
      zhvi: new Map(
        (zhviByMetro.get(regionId) ?? [])
          .filter((row) => row.period >= start && row.period <= end)
          .map((row) => [row.period, Number(row.zhvi_usd)]),
      ),
      fhfa: new Map(
        (fhfaByCbsa.get(meta.fhfa_cbsa) ?? []).map((row) => [
          row.period,
          Number(row.hpi_all_transactions_nsa),
        ]),
      ),
    }));
  return { months, metros };
};

const calculateHoldForPanel = (
  holdYears,
  panelDefinition,
  assumptions = base,
  pricePath = "zhvi",
) => {
  const cohortMonths = panelDefinition.months.length - holdYears * 12;
  const starts = panelDefinition.months.slice(0, cohortMonths);
  const runs = panelDefinition.metros.flatMap((metro) =>
    starts.map((startMonth) =>
      runLedger({ metro, startMonth, holdYears, assumptions, pricePath }),
    ),
  );
  return { runs, summary: summarise(runs, holdYears, cohortMonths) };
};

const comparison = [];
const check = (label, actual, expected, tolerance = 1e-10) => {
  const numeric = typeof actual === "number" && typeof expected === "number";
  const difference = numeric ? actual - expected : null;
  const pass = numeric ? Math.abs(difference) <= tolerance : actual === expected;
  comparison.push({ label, pass, actual, expected, difference, tolerance });
};
const compareSummary = (label, actual, expected) => {
  for (const field of [
    "holdYears",
    "runs",
    "cohortMonths",
    "buyWinRate",
    "medianGapShare",
    "p10GapShare",
    "p90GapShare",
  ]) {
    check(
      `${label}.${field}`,
      actual[field],
      expected[field],
      ["holdYears", "runs", "cohortMonths"].includes(field) ? 0 : 1e-10,
    );
  }
};

check("snapshot.housing.sha256", episode.meta.housingSnapshot.sha256, housingManifest.sha256);
check("snapshot.rates.sha256", episode.meta.rateSnapshot.sha256, ratesManifest.sha256);
check("snapshot.shiller.sha256", episode.meta.snapshot.sha256, shillerManifest.sha256);
check("files.zori.sha256", sha256(join(housingDir, "zori-normalised.csv")), housingManifest.normalisedFiles.zori.sha256);
check("files.zhvi.sha256", sha256(join(housingDir, "zhvi-normalised.csv")), housingManifest.normalisedFiles.zhvi.sha256);
check("files.fhfa.sha256", sha256(join(housingDir, "fhfa-hpi-normalised.csv")), housingManifest.normalisedFiles.fhfaHpi.sha256);
check("panel.metros", panel.length, episode.meta.window.metros, 0);
check("panel.months", requiredMonths.length, 99, 0);

const independentByHold = [];
let baseFiveYearRuns;
for (const actual of episode.byHold) {
  const calculated = calculateHold(actual.holdYears);
  independentByHold.push(calculated.summary);
  compareSummary(`byHold.${actual.holdYears}`, actual, calculated.summary);
  if (actual.holdYears === 5) baseFiveYearRuns = calculated.runs;
}

const fiveYearSummary = independentByHold.find((row) => row.holdYears === 5);
for (const field of [
  "runs",
  "metros",
  "cohortMonths",
  "buyWinRate",
  "medianGapShare",
  "p10GapShare",
  "p90GapShare",
]) {
  const expected =
    field === "metros"
      ? panel.length
      : field === "cohortMonths"
        ? fiveYearSummary.cohortMonths
        : fiveYearSummary[field];
  check(`headline.${field}`, episode.headline[field], expected, ["runs", "metros", "cohortMonths"].includes(field) ? 0 : 1e-10);
}

const best = baseFiveYearRuns.reduce((a, b) => (b.gapShare > a.gapShare ? b : a));
const worst = baseFiveYearRuns.reduce((a, b) => (b.gapShare < a.gapShare ? b : a));
for (const [label, actual, expected] of [
  ["headline.best.metro", episode.headline.best.metro, best.metro],
  ["headline.best.month", episode.headline.best.month, best.month],
  ["headline.best.gapShare", episode.headline.best.gapShare, best.gapShare],
  ["headline.worst.metro", episode.headline.worst.metro, worst.metro],
  ["headline.worst.month", episode.headline.worst.month, worst.month],
  ["headline.worst.gapShare", episode.headline.worst.gapShare, worst.gapShare],
]) check(label, actual, expected);

const groupRuns = (runs, keyOf) => {
  const groups = new Map();
  for (const run of runs) {
    const key = keyOf(run);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return groups;
};

const fiveYearByMetro = groupRuns(baseFiveYearRuns, (run) => run.regionId);
for (const actual of episode.byMetro) {
  const runs = fiveYearByMetro.get(actual.regionId) ?? [];
  const gapShares = runs.map((run) => run.gapShare).sort((a, b) => a - b);
  const rentYields = runs.map((run) => run.startRentYield).sort((a, b) => a - b);
  const expected = {
    metro: runs[0]?.metro,
    state: runs[0]?.state,
    sizeRank: runs[0]?.sizeRank,
    cohorts: runs.length,
    buyWinRate: runs.filter((run) => run.gapShare > 0).length / runs.length,
    medianGapShare: percentile(gapShares, 0.5),
    startRentYield: percentile(rentYields, 0.5),
  };
  for (const field of Object.keys(expected)) {
    check(
      `byMetro.${actual.regionId}.${field}`,
      actual[field],
      expected[field],
      ["sizeRank", "cohorts"].includes(field) ? 0 : 1e-10,
    );
  }
}

const fiveYearByCohort = groupRuns(baseFiveYearRuns, (run) => run.month);
for (const actual of episode.byCohort) {
  const runs = fiveYearByCohort.get(actual.month) ?? [];
  const gaps = runs.map((run) => run.gapShare).sort((a, b) => a - b);
  const expected = {
    ratePercent: runs[0]?.ratePercent,
    metros: runs.length,
    buyWinRate: runs.filter((run) => run.gapShare > 0).length / runs.length,
    medianGapShare: percentile(gaps, 0.5),
  };
  for (const field of Object.keys(expected)) {
    check(
      `byCohort.${actual.month}.${field}`,
      actual[field],
      expected[field],
      field === "metros" ? 0 : 1e-10,
    );
  }
}

const independentScenarios = [];
for (const scenario of episode.scenarioTable) {
  const assumptions = {
    downPct: base.downPct,
    propertyTax: scenario.propertyTax,
    insurance: scenario.insurance,
    maintenance: scenario.maintenance,
    buyCost: scenario.buyCost,
    sellCost: scenario.sellCost,
  };
  const summaries = [];
  for (const actual of scenario.byHold) {
    const expected =
      scenario.scenario === "base"
        ? independentByHold.find((row) => row.holdYears === actual.holdYears)
        : calculateHold(actual.holdYears, assumptions).summary;
    summaries.push(expected);
    compareSummary(`scenario.${scenario.scenario}.${actual.holdYears}`, actual, expected);
  }
  independentScenarios.push({ scenario: scenario.scenario, byHold: summaries });
}

const independentSellAxis = [];
for (const row of episode.sellAxis) {
  const expected = calculateHold(5, { ...base, sellCost: row.sellCost }).summary;
  independentSellAxis.push({ sellCost: row.sellCost, atBaseHold: expected });
  compareSummary(`sellAxis.${row.sellCost}`, row.atBaseHold, expected);
}

const fhfaFiveYear = calculateHold(5, base, "fhfa");
const baseByKey = new Map(
  baseFiveYearRuns.map((run) => [`${run.regionId}:${run.month}`, run]),
);
let disagreements = 0;
const disagreementMetros = new Set();
for (const run of fhfaFiveYear.runs) {
  const baseRun = baseByKey.get(`${run.regionId}:${run.month}`);
  if ((baseRun.gapShare > 0) !== (run.gapShare > 0)) {
    disagreements++;
    disagreementMetros.add(run.regionId);
  }
}
const independentFhfa = {
  holdYears: 5,
  zhviBuyWinRate: fiveYearSummary.buyWinRate,
  fhfaBuyWinRate: fhfaFiveYear.summary.buyWinRate,
  verdictAgreementRate: 1 - disagreements / fhfaFiveYear.runs.length,
  disagreeingRuns: disagreements,
  metrosWithAnyDisagreement: disagreementMetros.size,
};
for (const [field, expected] of Object.entries(independentFhfa)) {
  check(
    `fhfaSensitivity.${field}`,
    episode.fhfaSensitivity[field],
    expected,
    ["holdYears", "disagreeingRuns", "metrosWithAnyDisagreement"].includes(field)
      ? 0
      : 1e-10,
  );
}

const longPanel = buildPanelForWindow(
  episode.meta.longWindow.start,
  episode.meta.longWindow.end,
);
check("longPanel.metros", longPanel.metros.length, episode.meta.longWindow.metros, 0);
const independentLongByHold = [];
for (const actual of episode.longByHold) {
  const expected = calculateHoldForPanel(actual.holdYears, longPanel).summary;
  independentLongByHold.push(expected);
  compareSummary(`longByHold.${actual.holdYears}`, actual, expected);
}

const steadyGap = ({
  ratePercent,
  holdYears,
  homeGrowthAnnual,
  marketReturnAnnual,
  rentGrowthAnnual,
  rentYield,
}) => {
  const homeGrowth = (1 + homeGrowthAnnual) ** (1 / 12);
  const marketGrowth = (1 + marketReturnAnnual) ** (1 / 12);
  const rentGrowth = (1 + rentGrowthAnnual) ** (1 / 12);
  const monthlyRate = ratePercent / 100 / 12;
  const principal = 1 - base.downPct;
  const monthlyPayment = payment(principal, ratePercent / 100);
  let renterPortfolio = base.downPct + base.buyCost;
  let buyerPortfolio = 0;
  let balance = principal;
  const holdMonths = holdYears * 12;

  for (let month = 1; month <= holdMonths; month++) {
    renterPortfolio *= marketGrowth;
    buyerPortfolio *= marketGrowth;
    const homeValue = homeGrowth ** month;
    const ownerCash =
      monthlyPayment +
      (base.propertyTax + base.insurance + base.maintenance) * homeValue / 12;
    const rentCash = rentYield / 12 * rentGrowth ** (month - 1);
    if (ownerCash >= rentCash) renterPortfolio += ownerCash - rentCash;
    else buyerPortfolio += rentCash - ownerCash;
    balance = balance * (1 + monthlyRate) - monthlyPayment;
  }

  const buyerWealth =
    homeGrowth ** holdMonths * (1 - base.sellCost) - balance + buyerPortfolio;
  return buyerWealth - renterPortfolio;
};

const breakEvenRentYield = (row) => {
  let low = 0.001;
  let high = 0.3;
  for (let i = 0; i < 60; i++) {
    const midpoint = (low + high) / 2;
    if (steadyGap({ ...row, rentYield: midpoint }) > 0) high = midpoint;
    else low = midpoint;
  }
  return (low + high) / 2;
};

const expectedBreakEvenKeys = new Set(
  [3, 5, 6.5, 7].flatMap((rate) =>
    [3, 5, 7, 10, 15].map((hold) => `${rate}:${hold}`),
  ),
);
const actualBreakEvenKeys = new Set(
  episode.breakEven.map((row) => `${row.ratePercent}:${row.holdYears}`),
);
if (
  actualBreakEvenKeys.size !== expectedBreakEvenKeys.size ||
  [...expectedBreakEvenKeys].some((key) => !actualBreakEvenKeys.has(key))
) {
  throw new Error("break-even rate/hold grid does not match the documented 4x5 grid");
}

const independentBreakEven = [];
for (const actual of episode.breakEven) {
  if (
    actual.homeGrowthAnnual !== 0.03 ||
    actual.marketReturnAnnual !== 0.07 ||
    actual.rentGrowthAnnual !== 0.03
  ) {
    throw new Error(
      `break-even assumptions missing or changed at ${actual.ratePercent}%/${actual.holdYears}y`,
    );
  }
  const expected = breakEvenRentYield(actual);
  independentBreakEven.push({ ...actual, requiredRentYield: expected });
  check(
    `breakEven.${actual.ratePercent}.${actual.holdYears}.requiredRentYield`,
    actual.requiredRentYield,
    expected,
  );
}

const result = {
  method: {
    sourceIsolation: "pinned normalised CSVs only; simulation source not read or imported",
    ledger:
      "equal initial/monthly cash; renter invests avoided down payment and purchase cost; lower-cost side invests each monthly difference; nominal S&P total return",
  },
  panel: {
    start: windowStart,
    end: windowEnd,
    months: requiredMonths.length,
    metros: panel.length,
  },
  independentByHold,
  independentScenarios,
  independentSellAxis,
  independentFhfa,
  independentLongByHold,
  independentBreakEven,
  comparison,
};

const failures = comparison.filter((item) => !item.pass);
if (jsonOnly) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("Independent ep04 reference — pinned housing, FRED and Shiller snapshots");
  console.log(`panel ${panel.length} metros, ${windowStart}..${windowEnd}`);
  for (const row of independentByHold) {
    console.log(
      `${row.holdYears}y  n=${row.runs}  buy=${(row.buyWinRate * 100).toFixed(2)}%  ` +
        `median=${(row.medianGapShare * 100).toFixed(2)}%`,
    );
  }
  for (const item of failures.slice(0, 20)) {
    console.log(
      `FAIL  ${item.label}: actual=${item.actual} expected=${item.expected} difference=${item.difference}`,
    );
  }
  console.log(
    `${failures.length === 0 ? "PASS" : "FAIL"}  ep04 results: ` +
      `${comparison.length - failures.length}/${comparison.length} independent comparisons agree`,
  );
}
process.exitCode = failures.length === 0 ? 0 : 1;
