#!/usr/bin/env node
// Independent check of every number the ep07 v2 "The Nguyens: 15 or 30?" script speaks.
//
//   node tools/validate-ep07-story.mjs
//
// Reads ONLY the pinned FRED mortgage-rate snapshot, the pinned Shiller CSV,
// results.json (to cross-check, never as a source) and the narration of record
// (nguyens/lines.json). Re-runs amortization and the invest-the-difference replay
// with its own arithmetic, using the convention the 2026-08-02 audit pinned:
// contributions at the BEGINNING of each return month, nominal dollars, deflated
// once at the end. For each claim it checks (1) the number is what the data says at
// the rounding the line uses and (2) the line still says it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const ep = join(root, "episodes", "ep07-15-vs-30-year");
const parse = (text) => {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
};
const [ratesCsv, shillerCsv, results, script] = await Promise.all([
  readFile(join(root, "data", "snapshots", "fred-housing-2026-07-31", "fred-housing-normalised.csv"), "utf8").then(parse),
  readFile(join(root, "data", "snapshots", "shiller-2026-07-26", "shiller-monthly.csv"), "utf8").then(parse),
  readFile(join(ep, "results.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "nguyens", "lines.json"), "utf8").then(JSON.parse),
]);

let checks = 0;
const failures = [];
const check = (ok, what) => { checks += 1; if (!ok) failures.push(what); };
const line = (id) => script.lines.find((l) => l.id === id)?.text.replace(/\*/g, "") ?? "";
const says = (id, phrase, ok, detail) => {
  check(line(id).includes(phrase), `${id} no longer says "${phrase}"`);
  check(ok, `${id} "${phrase}" is false: ${detail}`);
};

const rate = new Map(ratesCsv.map((r) => [r.month, { r30: Number(r.mortgage30usPercent), r15: Number(r.mortgage15usPercent) }]));
const sh = shillerCsv.map((r) => ({ m: r.date, cpi: Number(r.cpi), tr: Number(r.realTotalReturnPrice) * Number(r.cpi) }));
const at = new Map(sh.map((r, i) => [r.m, i]));
const lastMonth = sh.at(-1).m;
const addMonths = (m, k) => { const [y, mo] = m.split("-").map(Number); const s = y * 12 + mo - 1 + k; return `${Math.floor(s / 12)}-${String((s % 12) + 1).padStart(2, "0")}`; };

const pay = (loan, ratePct, n) => { const r = ratePct / 1200; return loan * r / (1 - (1 + r) ** -n); };

// One signing month replayed for `months`. Returns yearly snapshots in signing-month dollars.
function replay(start, loan, months) {
  const { r30, r15 } = rate.get(start);
  const p15 = pay(loan, r15, 180), p30 = pay(loan, r30, 360), diff = p15 - p30;
  let b15 = loan, b30 = loan, f15 = 0, f30 = 0;
  const s0 = at.get(start), snaps = [{ y: 0, b15, b30, f15, f30 }];
  for (let k = 0; k < months; k += 1) {
    const g = sh[s0 + k + 1].tr / sh[s0 + k].tr;
    b15 = Math.max(0, b15 * (1 + r15 / 1200) - p15);
    b30 = Math.max(0, b30 * (1 + r30 / 1200) - p30);
    f15 = (f15 + (k >= 180 ? p15 : 0)) * g;
    f30 = (f30 + diff) * g;
    if ((k + 1) % 12 === 0) {
      const real = sh[s0].cpi / sh[s0 + k + 1].cpi;
      snaps.push({ y: (k + 1) / 12, b15: b15 * real, b30: b30 * real, f15: f15 * real, f30: f30 * real });
    }
  }
  return { r30, r15, p15, p30, diff, snaps };
}

// ---- the 2026 kitchen: $400k at 7.0% / 6.5% (the break-even row)
const LOAN_NOW = 400000;
const pNow15 = pay(LOAN_NOW, 6.5, 180), pNow30 = pay(LOAN_NOW, 7.0, 360);
says("N00", "four hundred thousand dollar", LOAN_NOW === 400000, "loan");
says("N01", "six and a half percent: about thirty-five hundred", Math.round(pNow15 / 100) * 100 === 3500, `$${pNow15.toFixed(0)}`);
says("N01", "seven percent: about twenty-seven hundred", Math.round(pNow30 / 100) * 100 === 2700, `$${pNow30.toFixed(0)}`);
says("M01", "eight hundred less", Math.round((pNow15 - pNow30) / 100) * 100 === 800, `$${(pNow15 - pNow30).toFixed(0)}`);

// ---- the 1993 replay: Uncle Tu, $200k, January 1993 (median completed window)
const START = "1993-01", LOAN_TU = 200000;
const tu = replay(START, LOAN_TU, 360);
const y = (n) => tu.snaps.find((s) => s.y === n);
const K = (v) => Math.round(v / 1000);
says("T01", "nineteen ninety-three", rate.has(START), "1993 rates exist");
says("N02", "January nineteen ninety-three", START === "1993-01", "start month");
says("B01", "sixty-four thousand", K(y(7).f30) === 64, `$${y(7).f30.toFixed(0)}`);
says("B01", "Stocks are booming", y(7).f30 > 7 * 12 * tu.diff * (sh[at.get(START)].cpi / sh[at.get("2000-01")].cpi), "invested grew beyond contributions");
says("A01", "Nothing invested yet", y(7).f15 === 0 && y(7).b15 < y(6).b15, "15 path invests nothing before payoff");
says("B02", "forty-eight thousand", K(y(10).f30) === 48 && y(10).f30 < y(7).f30, `$${y(10).f30.toFixed(0)}`);
says("A02", "Two thousand eight. My house is paid off", addMonths(START, 180) === "2008-01" && y(15).b15 < 1, `payoff ${addMonths(START, 180)}`);
says("N04", "the two thousand eight crash", y(16).f30 < y(15).f30 * 0.75, `30 path ${y(15).f30.toFixed(0)} -> ${y(16).f30.toFixed(0)}`);
says("A03", "Four hundred eighteen thousand", K(y(30).f15) === 418 && y(30).b15 < 1, `$${y(30).f15.toFixed(0)}`);
says("B03", "Three hundred twenty-eight thousand", K(y(30).f30) === 328 && y(30).b30 < 1, `$${y(30).f30.toFixed(0)}`);
const gapTu = y(30).f15 - y(30).f30;
says("N05", "about ninety thousand dollars", Math.round(gapTu / 10000) === 9, `$${gapTu.toFixed(0)}`);
const s0 = at.get(START), s1 = at.get(addMonths(START, 360));
const cagr = (sh[s1].tr / sh[s0].tr) ** (1 / 30) - 1;
says("N05", "almost ten percent a year", cagr >= 0.095 && cagr < 0.1, `${(cagr * 100).toFixed(2)}%`);
says("N05", "two crashes", y(10).f30 < y(7).f30 && y(16).f30 < y(15).f30, "30 path fell after 2000 and after 2008");
// cross-check the published result (median completed window)
const pub = results.cohorts30.find((c) => c.month === START);
check(Math.abs(-gapTu / LOAN_TU - pub.gapShare) < 5e-4, `1993-01 gap ${(-gapTu / LOAN_TU).toFixed(4)} vs results ${pub.gapShare}`);

// ---- every signing month since the 15-year series began
const months = [...rate.keys()].filter((m) => m >= "1991-09" && !Number.isNaN(rate.get(m).r15)).sort();
const complete = months.filter((m) => addMonths(m, 360) <= lastMonth);
const completeGaps = complete.map((m) => { const r = replay(m, 1, 360); const e = r.snaps.at(-1); return { m, r30: r.r30, gap: e.f30 - e.f15 }; });
says("N06", "since nineteen ninety-one", complete[0] === "1991-09", `first ${complete[0]}`);
says("N06", "fifty-eight of them", complete.length === 58, `${complete.length}`);
says("N06", "about seven to nine percent", completeGaps.every((c) => c.r30 >= 6.5 && c.r30 <= 9.5), completeGaps.map((c) => c.r30).join(","));
says("N06", "won all fifty-eight", completeGaps.every((c) => c.gap < 0), `${completeGaps.filter((c) => c.gap >= 0).length} not won`);
const half = months.filter((m) => addMonths(m, 180) <= lastMonth).map((m) => { const r = replay(m, 1, 180); const e = r.snaps.at(-1); return { m, r30: r.r30, net: e.f30 - e.b30 }; });
const nineties = half.filter((c) => c.m < "2000-01"), late = half.filter((c) => c.m >= "2005-01");
says("N07", "the thirty was never ahead", nineties.length > 0 && nineties.every((c) => c.net <= 0), `${nineties.filter((c) => c.net > 0).length}/${nineties.length} ahead`);
says("N07", "two thousand five to twenty eleven", late.at(-1).m.startsWith("2011"), `last ${late.at(-1).m}`);
says("N07", "about four to seven percent", late.every((c) => c.r30 >= 4 && c.r30 <= 7), `${Math.min(...late.map((c) => c.r30))}-${Math.max(...late.map((c) => c.r30))}`);
says("N07", "ahead every time", late.every((c) => c.net > 0), `${late.filter((c) => c.net <= 0).length}/${late.length} not ahead`);
check(half.length === results.checkpoint15y.cohorts, `checkpoint cohorts ${half.length} vs results ${results.checkpoint15y.cohorts}`);

// ---- today's arithmetic: 7.0% / 6.5%, no history needed
const p15u = pay(1, 6.5, 180), p30u = pay(1, 7.0, 360), d = p15u - p30u;
const req = ((p15u / d - 1) ** (1 / 180)) ** 12 - 1; // monthly d for 360 months must equal p15 for months 181-360
says("N09", "more than eight percent a year", req > 0.08 && req < 0.085, `${(req * 100).toFixed(2)}%`);
says("N12", "more than about eight percent", req > 0.08 && req < 0.085, `${(req * 100).toFixed(2)}%`);
const row = results.breakEven.find((b) => b.rate30Percent === 7 && b.spreadPp === 0.5);
check(Math.abs(req - row.requiredAnnualReturn30y) < 1e-6, `required return ${req} vs results ${row.requiredAnnualReturn30y}`);
let bal = 1, paid = 0, mo = 0;
while (bal > 1e-12) { mo += 1; const due = bal * (1 + 7 / 1200); const p = Math.min(p15u, due); bal = due - p; paid += p; }
const extra = paid - 180 * p15u;
says("N10", "done eleven months later", mo - 180 === 11, `payoff month ${mo}`);
says("N10", "about nine percent of the loan extra", extra > 0.085 && extra < 0.095, `${(extra * 100).toFixed(2)}%`);
check(mo === row.hybridPayoffMonths && Math.abs(extra - row.hybridExtraCostShare) < 1e-6, `hybrid ${mo}/${extra} vs results ${row.hybridPayoffMonths}/${row.hybridExtraCostShare}`);

// Every line with a number word must be one the claims above know about.
const numberWords = /\b(hundred|thousand|million|percent|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|nineteen|eleven|fifteen)\b/i;
const claimed = new Set(["N00", "N01", "M01", "T01", "N02", "B01", "B02", "A02", "N04", "A03", "B03", "N05", "N06", "N07", "N09", "N10", "N12"]);
// lines that only name the two loan terms or the device, no data claim
const termsOnly = new Set(["L01", "M02", "L02", "N03", "N08", "M03", "L03", "L04", "N11", "N13", "N14", "N15", "A01"]);
for (const l of script.lines) {
  if (numberWords.test(l.text) && !claimed.has(l.id) && !termsOnly.has(l.id)) failures.push(`${l.id} speaks a number no claim checks: "${l.text}"`);
}

// ---- the 9:16 Short (nguyens-short/lines.json): same replay, its own words
const shortScript = JSON.parse(await readFile(join(ep, "nguyens-short", "lines.json"), "utf8"));
const sline = (id) => shortScript.lines.find((l) => l.id === id)?.text.replace(/\*/g, "") ?? "";
const ssays = (id, phrase, ok, detail) => {
  check(sline(id).includes(phrase), `short ${id} no longer says "${phrase}"`);
  check(ok, `short ${id} "${phrase}" is false: ${detail}`);
};
ssays("S01", "in nineteen ninety-three", START === "1993-01", "start");
ssays("S02", "Sixty-four thousand", K(y(7).f30) === 64, `$${y(7).f30.toFixed(0)}`);
ssays("S03", "Nothing invested", y(7).f15 === 0, "15 path");
ssays("S04", "forty-eight thousand", K(y(10).f30) === 48, `$${y(10).f30.toFixed(0)}`);
ssays("S05", "Two thousand eight. House paid off", addMonths(START, 180) === "2008-01" && y(15).b15 < 1, "payoff");
ssays("S05", "right into the crash", y(16).f30 < y(15).f30 * 0.75, "2008 crash follows payoff");
ssays("S06", "four hundred eighteen thousand", K(y(30).f15) === 418, `$${y(30).f15.toFixed(0)}`);
ssays("S07", "three hundred twenty-eight thousand", K(y(30).f30) === 328, `$${y(30).f30.toFixed(0)}`);
ssays("S08", "every finished loan signed at seven to nine percent", completeGaps.every((c) => c.gap < 0 && c.r30 >= 6.5 && c.r30 <= 9.5), "58/58");
ssays("S08", "the thirty was ahead at the halfway mark", late.every((c) => c.net > 0), "2005-2011 at year 15");
for (const l of shortScript.lines) {
  if (numberWords.test(l.text) && !["S01", "S02", "S04", "S05", "S06", "S07", "S08"].includes(l.id) && !/^The fifteen\. Nothing/.test(l.text)) failures.push(`short ${l.id} speaks a number no claim checks: "${l.text}"`);
}

if (failures.length) {
  console.error(`validate-ep07-story: ${failures.length} FAIL of ${checks}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`validate-ep07-story: ${checks}/${checks} PASS (${complete.length} completed windows, ${half.length} year-15 checkpoints re-run independently)`);
}
