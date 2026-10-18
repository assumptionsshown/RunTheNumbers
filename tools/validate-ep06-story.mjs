#!/usr/bin/env node
// Independent check of every number the ep06 "Walt and June" dialogue speaks.
//
//   node tools/validate-ep06-story.mjs
//
// Reads ONLY the pinned Shiller CSV, the renderer input batch.json, and the
// narration of record (walt-june/lines.json). It re-runs the 4% rule for every
// cohort with its own arithmetic (it imports neither the .NET sim, nor the
// renderer, nor validate-ep06), then checks two things for each claim:
//   1. the number is what the data says, at the rounding the line uses;
//   2. the line actually says it, so a script edit cannot drift silently.
// Written by Claude while Codex is unavailable, to the validate-ep05-doors standard.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const ep = join(root, "episodes", "ep06-four-percent-rule");
const [csv, batch, script] = await Promise.all([
  readFile(join(root, "data", "snapshots", "shiller-2026-07-26", "shiller-monthly.csv"), "utf8"),
  readFile(join(ep, "batch.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "walt-june", "lines.json"), "utf8").then(JSON.parse),
]);

let checks = 0;
const failures = [];
const check = (ok, what) => { checks += 1; if (!ok) failures.push(what); };

// ---- data: monthly rows keyed by YYYY-MM
const [head, ...rows] = csv.trim().split(/\r?\n/);
const cols = head.split(",");
const at = (name) => cols.indexOf(name);
const M = new Map(rows.map((r) => { const f = r.split(","); return [f[0], f]; }));
const num = (date, name) => Number(M.get(date)[at(name)]);
const jan = (y, name) => num(`${y}-01`, name);

// One January-to-January year, real terms. Bond leg: a ten-year par bond held a
// year, coupon = starting yield, price change = -modified duration x yield change,
// deflated by CPI. Same disclosed proxy, written again from its definition.
function year(y) {
  const cpi0 = jan(y, "cpi"), cpi1 = jan(y + 1, "cpi");
  const inflation = cpi1 / cpi0;
  const stock = jan(y + 1, "realTotalReturnPrice") / jan(y, "realTotalReturnPrice");
  const r0 = jan(y, "gs10") / 100, r1 = jan(y + 1, "gs10") / 100;
  let dur = 0;
  for (let k = 1; k <= 10; k++) dur += (k * r0) / (1 + r0) ** k;
  dur += 10 / (1 + r0) ** 10;          // Macaulay duration of a par bond, summed
  const modified = dur / (1 + r0);
  const bond = (1 + r0 - modified * (r1 - r0)) / inflation;
  return { stock, bond, inflation };
}

const RATE = 0.04, H = 30, SHARE = 0.6;
function retire(start, rate = RATE) {
  const path = [1];
  let bal = 1, depleted = null;
  for (let i = 0; i < H; i++) {
    bal -= rate;
    if (bal <= 0) { depleted ??= start + i; for (let j = i; j < H; j++) path.push(0); bal = 0; break; }
    const y = year(start + i);
    bal *= SHARE * y.stock + (1 - SHARE) * y.bond;
    path.push(bal);
  }
  return { start, path, final: path[H], survived: depleted === null, depleted };
}

const starts = [];
for (let y = 1871; M.has(`${y + H}-01`); y++) starts.push(y);
const all = starts.map((s) => retire(s));
const walt = retire(1929), june = retire(1966);
const K = (v) => Math.round(v * 1000);         // $1M start -> thousands

// ---- the two story paths match the renderer input exactly
for (const r of [walt, june]) {
  const b = batch.cohorts.find((c) => c.startYear === r.start);
  check(b && b.path.length === H + 1, `${r.start}: batch path missing or wrong length`);
  r.path.forEach((v, i) => check(Math.abs(v - b.path[i]) < 1e-9, `${r.start} year ${i}: ${v} vs batch ${b.path[i]}`));
  check(r.survived === b.survived && r.depleted === b.depletedInYear, `${r.start}: survival/depletion disagrees with batch`);
}

// ---- claims, each tied to the words that speak it
const line = (id) => script.lines.find((l) => l.id === id)?.text.replace(/\*/g, "") ?? "";
const says = (id, phrase, ok, detail) => {
  check(line(id).includes(phrase), `${id} no longer says "${phrase}"`);
  check(ok, `${id} "${phrase}" is false: ${detail}`);
};
const cpi = (a, b) => jan(b, "cpi") / jan(a, "cpi");
const cum = (a, b, leg) => { let g = 1; for (let y = a; y < b; y++) g *= year(y)[leg]; return g; };

says("N00", "a million dollars", walt.path[0] === 1 && batch.cohorts.every((c) => c.path[0] === 1), "every cohort starts at $1M");
says("N01", "four percent rule", batch.meta.rate === RATE, "batch meta rate");
says("N01", "forty thousand", RATE * 1e6 === 40000, "4% of $1M");
says("N01P", "thirty years", batch.meta.horizonYears === H, "batch meta horizon");
says("N03", "sixty percent in", batch.meta.stockShare === SHARE, "batch meta mix");
says("N03", "forty percent in", Math.abs(1 - batch.meta.stockShare - 0.4) < 1e-9, "batch meta mix");
says("N04", "One of them runs out", walt.survived !== june.survived, "exactly one survives");

let peak = 0, trough = Infinity;
for (let m = 1; m <= 12; m++) peak = Math.max(peak, num(`1929-${String(m).padStart(2, "0")}`, "price"));
for (const [d] of M) if (d >= "1929-10" && d <= "1932-12") trough = Math.min(trough, num(d, "price"));
const drop = 1 - trough / peak;
says("W03", "eighty-five percent", Math.round(drop * 100) === 85, `peak-to-trough ${(drop * 100).toFixed(1)}%`);
// "the worst crash on record": the deepest peak-to-trough fall of the whole price series.
let runPeak = 0, deepest = 0, deepestAt = "";
for (const [d] of M) { const p = num(d, "price"); runPeak = Math.max(runPeak, p); if (1 - p / runPeak > deepest) { deepest = 1 - p / runPeak; deepestAt = d; } }
says("N02", "the worst crash on record, nineteen twenty-nine", deepestAt >= "1929-10" && deepestAt <= "1932-12" && Math.abs(deepest - drop) < 1e-9, `deepest fall ${(deepest * 100).toFixed(1)}% at ${deepestAt}`);
says("N02", "nineteen sixty-six", june.start === 1966, "June's start year");
const walt32 = 40000 * cpi(1929, 1932);
says("W04", "thirty-three thousand", Math.round(walt32 / 1000) === 33 && walt32 < 40000, `$${walt32.toFixed(0)}`);
says("J02", "eight hundred ninety-three thousand", K(june.path[3]) === 893, `${K(june.path[3])}k`);
// "spent three years of money" (bubble: Spent $120,000): the bag fell by about the
// withdrawals alone, i.e. her investments roughly held (a small real gain).
says("J02", "spent three years of money", june.path[3] > 1 - 3 * RATE && june.path[3] < 1 - 3 * RATE + 0.03, `y3 ${june.path[3].toFixed(4)} vs 0.88 spend-only`);
says("W05", "Six hundred fifty thousand", Math.round(walt.path[3] * 100) === 65, `${K(walt.path[3])}k`);
says("W06", "A million seventy-six", K(walt.path[8]) === 1076, `${K(walt.path[8])}k`);
says("W06", "More than I started with", walt.path[8] > 1, `${walt.path[8]}`);
const june74 = 40000 * cpi(1966, 1974);
says("J03", "fifty-eight thousand six hundred", Math.round(june74 / 100) === 586, `$${june74.toFixed(0)}`);
says("J04", "six hundred fifteen thousand", K(june.path[8]) === 615, `${K(june.path[8])}k`);
says("NF1", "Walt's crash is already over", walt.path[8] > 1, `walt y8 ${walt.path[8].toFixed(3)}`);
says("NF1", "June's trouble is only starting", june.path[16] < june.path[8] && june.path[8] < june.path[3], "June falls y3 > y8 > y16");
says("NF1", "It's prices", june74 / 40000 > 1.4, `CPI 1966-74 x${(june74 / 40000).toFixed(3)}`);
const c6682 = cpi(1966, 1982);
says("J05", "nearly tripled", c6682 >= 2.8 && c6682 < 3, `CPI x${c6682.toFixed(3)}`);
says("J05", "a hundred eighteen thousand six hundred", Math.round(40000 * c6682 / 100) === 1186, `$${(40000 * c6682).toFixed(0)}`);
says("J06", "two hundred four thousand", K(june.path[16]) === 204, `${K(june.path[16])}k`);
says("NS1", "while they're down", cum(1966, 1982, "stock") < 1 && cum(1966, 1982, "bond") < 1, "both legs below 1 in real terms 1966-82");
says("W07", "Prices jumped after the war", cpi(1945, 1949) > 1.2, `CPI x${cpi(1945, 1949).toFixed(3)}`);
says("W07", "Five hundred thirty-three thousand", K(walt.path[20]) === 533, `${K(walt.path[20])}k`);
const waltMin = walt.path.indexOf(Math.min(...walt.path));
says("W07", "My lowest ever. Lower than the crash", waltMin === 20 && walt.path[20] < walt.path[3], `min at year ${waltMin}`);
const bull = cum(1982, 1989, "stock");
says("J07", "more than doubled", bull >= 2 && bull < 2.8, `real stocks 1982-89 x${bull.toFixed(3)}`);
says("J07", "two hundred thousand left", Math.abs(june.path[16] - 0.2) < 0.02, `${K(june.path[16])}k`);
// The run-out year sits close to a boundary (Jan 1989 balance vs one year's
// withdrawal), so the line says "less than one year left", never a dollar figure.
says("J08", "nineteen eighty-nine. Twenty-three years in", june.depleted === 1989 && 1966 + 23 === 1989, `out ${june.depleted}`);
says("J08", "Less than one year of money left", june.path[23] > 0 && june.path[23] < RATE, `${(june.path[23] * 1e6).toFixed(0)} vs ${RATE * 1e6}`);
says("W08", "Seven hundred forty-nine thousand", K(walt.path[30]) === 749 && walt.survived, `${K(walt.path[30])}k`);

says("N06", "prices *fell*".replace(/\*/g, ""), cpi(1929, 1932) < 1, `CPI x${cpi(1929, 1932).toFixed(3)}`);
const ws = cum(1929, 1932, "stock"), wb = cum(1929, 1932, "bond");
says("N06", "His stocks crashed", ws < 0.6, `real stocks x${ws.toFixed(3)}`);
says("N06", "gained thirty-one percent", Math.round((wb - 1) * 100) === 31, `real bonds x${wb.toFixed(3)}`);
says("N06", "the market came back", walt.path[8] > walt.path[3], "path recovers by 1937");
let risingEveryYear = true;
for (let y = 1966; y < 1982; y++) if (year(y).inflation <= 1) risingEveryYear = false;
says("N07", "sixteen years of rising prices", risingEveryYear, "CPI fell in some year 1966-82");
const js = cum(1966, 1982, "stock"), jb = cum(1966, 1982, "bond");
says("N07", "stocks lost twenty percent", Math.round((1 - js) * 100) === 20, `x${js.toFixed(3)}`);
says("N07", "bonds lost almost half", jb > 0.5 && jb < 0.6, `x${jb.toFixed(3)}`);
let firstSurge = null;
for (let y = 1933; y < 1959; y++) if (year(y).inflation > 1.05) { firstSurge = y; break; }
says("N08", "in the forties", cpi(1941, 1949) > 1.5, `CPI x${cpi(1941, 1949).toFixed(3)}`);
says("N08", "twelve years in", firstSurge === 1941, `first >5% year starts ${firstSurge}`);
says("N08", "over eight hundred thousand", walt.path[12] > 0.8, `${K(walt.path[12])}k`);

const failed = all.filter((r) => !r.survived);
says("N09", "a hundred twenty-six", all.length === 126 && batch.cohorts.length === 126, `${all.length} cohorts`);
says("N09", "eighteen seventy-one to nineteen ninety-six", starts[0] === 1871 && starts.at(-1) === 1996, `${starts[0]}-${starts.at(-1)}`);
says("N10", "A hundred twenty", all.length - failed.length === 120, `${all.length - failed.length} survived`);
says("N10", "Six", failed.length === 6, `${failed.length} failed`);
says("N11", "nineteen sixty-four and nineteen sixty-nine", failed.every((r) => r.start >= 1964 && r.start <= 1969), failed.map((r) => r.start).join(","));
const finals = all.map((r) => r.final).sort((a, b) => a - b);
const median = (finals[62] + finals[63]) / 2;
says("N12", "a million and a quarter", Math.abs(median - 1.25) < 0.05, `median ${median.toFixed(4)}`);
says("N12", "far better than Walt", walt.final < median - 0.3, `walt ${walt.final.toFixed(3)}`);
says("N13", "almost always", (all.length - failed.length) / all.length >= 0.95, "success rate");
says("N13", "a hundred twenty times out of a hundred twenty-six", all.length - failed.length === 120 && all.length === 126, `${all.length - failed.length}/${all.length}`);
// Lesson two is a warning sign, NOT a cause: every failure saw prices up by half or
// more in its first ten years, but some starts were worse on that measure and lasted.
const cpi10 = (s) => cpi(s, s + 10);
says("N13B", "A crash is not what sinks you", walt.survived && cpi10(1929) < 1, `1929 cpi10 x${cpi10(1929).toFixed(3)}`);
says("N13B", "by half or more", failed.every((r) => cpi10(r.start) >= 1.5), failed.map((r) => `${r.start}:${cpi10(r.start).toFixed(3)}`).join(","));
says("N13B", "first ten years", failed.every((r) => r.depleted - r.start > 10), "every failure ran out after year 10, so the sign came first");
const worseAndLasted = all.filter((r) => r.survived && cpi10(r.start) > Math.max(...failed.map((f) => cpi10(f.start))));
says("N13B", "Some had it even worse and still made it", worseAndLasted.length > 0, worseAndLasted.map((r) => r.start).join(","));
says("N14B", "keep four percent", RATE === 0.04, "the rule's rate");

let lo = 0.01, hi = 0.1;
for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (starts.every((s) => retire(s, mid).survived)) lo = mid; else hi = mid; }
says("N14", "three point six percent", Math.round(lo * 1000) === 36 && Math.abs(lo - batch.meta.safeRate) < 1e-6, `safe ${(lo * 100).toFixed(4)}%`);
says("N14", "Thirty-six thousand", Math.round(lo * 1e6 / 1000) === 36, `$${(lo * 1e6).toFixed(0)}`);

// ---- the title is a claim too: "The 4% Rule's Worst Year to Retire Wasn't 1929"
const lasted = (r) => (r.survived ? Infinity : r.depleted - r.start);
const worst = [...all].sort((a, b) => lasted(a) - lasted(b) || a.final - b.final)[0];
check(worst.start === 1966 && lasted(worst) === 23, `title: worst start year is ${worst.start} (lasted ${lasted(worst)}), expected 1966 / 23`);
check(all.filter((r) => lasted(r) === lasted(worst)).length === 1, "title: the worst year is not unique");
check(walt.survived, "title: 1929 must survive");

// ---- meter claims the screen makes (renderer derives them; check the data agrees)
check(K(june.path[3] - walt.path[3]) === 241, `year 3 June ahead ${K(june.path[3] - walt.path[3])}k, expected 241k`);
check(K(walt.path[8] - june.path[8]) === 461, `year 8 Walt ahead ${K(walt.path[8] - june.path[8])}k, expected 461k`);
for (let i = 7; i <= H; i++) check(walt.path[i] > june.path[i], `year ${i}: Walt not ahead`);

// Every line the script has must be one the claims above know about, or carry no number.
const numberWords = /\b(hundred|thousand|million|percent|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|nineteen|eighteen)\b/i;
const claimed = new Set(["N00", "N01", "N01P", "N02", "N03", "N04", "NF1", "NS1", "N13B", "N14B", "W03", "W04", "J02", "W05", "W06", "J03", "J04", "J05", "J06", "W07", "J07", "J08", "W08", "N06", "N07", "N08", "N09", "N10", "N11", "N12", "N13", "N14"]);
const datesOnly = new Set(["W01", "J01", "W02", "N15", "N16", "N05"]); // years/dates of the device, no data claim
for (const l of script.lines) {
  if (numberWords.test(l.text) && !claimed.has(l.id) && !datesOnly.has(l.id)) failures.push(`${l.id} speaks a number no claim checks: "${l.text}"`);
}

if (failures.length) {
  console.error(`validate-ep06-story: ${failures.length} FAIL of ${checks}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`validate-ep06-story: ${checks}/${checks} PASS (${all.length} cohorts re-run independently)`);
}
