#!/usr/bin/env node
// Independent check of every number the ep08 "The Nguyens: Pay It Off or Invest?" script speaks.
//
//   node tools/validate-ep08-story.mjs
//
// Reads ONLY the pinned FRED mortgage-rate snapshot, the pinned Shiller CSV,
// doors.json (to prove the ledger, never as a source) and the narration of record
// (nguyens/lines.json, nguyens-short/lines.json). The pure pay-down and invest paths
// use the arithmetic of tools/validate-ep05-doors.mjs: contribution first, then that
// month's growth, deflated once by CPI over the window. Before any story number is
// trusted, that ledger must reproduce the audited doors.json at its own settings.
// For each claim it checks (1) the number is what the data says at the rounding the
// line uses and (2) the line still says it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const ep = join(root, "episodes", "ep08-pay-down-or-invest");
const parse = (text) => {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
};
const [ratesCsv, shillerCsv, doors, script, shortScript] = await Promise.all([
  readFile(join(root, "data", "snapshots", "fred-housing-2026-07-31", "fred-housing-normalised.csv"), "utf8").then(parse),
  readFile(join(root, "data", "snapshots", "shiller-2026-07-26", "shiller-monthly.csv"), "utf8").then(parse),
  // doors.json stays private (its note names a personal location), so the public mirror skips the bridge
  readFile(join(root, "episodes", "ep05-mortgage-or-invest", "doors.json"), "utf8").then(JSON.parse).catch(() => null),
  readFile(join(ep, "nguyens", "lines.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "nguyens-short", "lines.json"), "utf8").then(JSON.parse),
]);

let checks = 0;
const failures = [];
const check = (ok, what) => { checks += 1; if (!ok) failures.push(what); };
const line = (id) => script.lines.find((l) => l.id === id)?.text.replace(/\*/g, "") ?? "";
const says = (id, phrase, ok, detail) => {
  check(line(id).includes(phrase), `${id} no longer says "${phrase}"`);
  check(ok, `${id} "${phrase}" is false: ${detail}`);
};
const sline = (id) => shortScript.lines.find((l) => l.id === id)?.text.replace(/\*/g, "") ?? "";
const ssays = (id, phrase, ok, detail) => {
  check(sline(id).includes(phrase), `short ${id} no longer says "${phrase}"`);
  check(ok, `short ${id} "${phrase}" is false: ${detail}`);
};

const sh = shillerCsv.filter((r) => r.cpi !== "" && Number.isFinite(Number(r.cpi)))
  .map((r) => ({ m: r.date, cpi: Number(r.cpi), tr: Number(r.realTotalReturnPrice) * Number(r.cpi) }));
const rateBy = new Map(ratesCsv.filter((r) => r.mortgage30usPercent !== "").map((r) => [r.month, Number(r.mortgage30usPercent)]));
const at = new Map(sh.map((r, i) => [r.m, i]));
const addMonths = (m, k) => { const [y, mo] = m.split("-").map(Number); const s = y * 12 + mo - 1 + k; return `${Math.floor(s / 12)}-${String((s % 12) + 1).padStart(2, "0")}`; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), h = 0.5 * (s.length - 1), lo = Math.floor(h), hi = Math.ceil(h); return s[lo] + (h - lo) * (s[hi] - s[lo]); };
const K = (v) => Math.round(v / 1000);
const K10 = (v) => Math.round(v / 10000) * 10;

// One signing month for `months`, on `loan`, with `extra` spare cash a month. The
// arithmetic of validate-ep05-doors.mjs, recording the yearly state in signing-month dollars.
function play(pct, i0, months, extra, loan) {
  if (i0 + months >= sh.length) return null;
  const r = pct / 1200, pay = loan * r / (1 - (1 + r) ** -360), budget = pay + extra;
  let invBal = loan, invPort = 0, preBal = loan, prePort = 0, payoff = -1;
  const year = [{ y: 0, invBal, invPort, preBal, prePort }];
  const monthly = [];
  for (let k = 0; k < months; k += 1) {
    const g = sh[i0 + k + 1].tr / sh[i0 + k].tr;
    if (invBal > 0) invBal = Math.max(0, invBal + invBal * r - pay);
    invPort = (invPort + (invBal > 0 ? extra : budget)) * g;
    if (preBal > 0) {
      preBal = preBal + preBal * r - budget;
      if (preBal <= 0) { prePort = (prePort - preBal) * g; preBal = 0; payoff = k + 1; } else prePort *= g;
    } else prePort = (prePort + budget) * g;
    const d = sh[i0 + k + 1].cpi / sh[i0].cpi;
    monthly.push((invPort - invBal - prePort + preBal) / d);
    if ((k + 1) % 12 === 0) year.push({ y: (k + 1) / 12, invBal: invBal / d, invPort: invPort / d, preBal: preBal / d, prePort: prePort / d });
  }
  const e = year.at(-1);
  return { m: sh[i0].m, pct, pay, payoff, year, monthly, inv: e.invPort - e.invBal, pre: e.prePort - e.preBal, gap: e.invPort - e.invBal - e.prePort + e.preBal };
}

// ---- the bridge: this ledger must reproduce the audited doors.json at spare share 0.5
if (doors) {
  const spareOf = (pct) => { const r = pct / 1200; return doors.meta.spareShare * r / (1 - (1 + r) ** -360); };
  const fixed = (pct) => { const out = []; for (let i = 0; i < sh.length; i += 1) { const x = play(pct, i, 360, spareOf(pct), 1); if (x) out.push(x); } return out; };
  const sum = (runs) => {
    const w = runs.filter((x) => x.gap > 0).map((x) => x.gap), l = runs.filter((x) => x.gap <= 0).map((x) => -x.gap);
    return { starts: runs.length, investWins: w.length, prepayWins: l.length, investWinMedianShare: w.length ? median(w) : null, prepayWinMedianShare: l.length ? median(l) : null };
  };
  const compare = (label, mine, theirs) => {
    for (const k of Object.keys(mine)) {
      const a = mine[k], b = theirs[k];
      check(a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9), `bridge ${label}.${k}: ledger ${a} vs doors.json ${b}`);
    }
  };
  compare("fixed7", sum(fixed(7)), doors.door7.fixedRate7Counterfactual30);
  compare("fixed3", sum(fixed(3)), doors.door3.byHorizon.find((h) => h.horizonYears === 30).summary);
}

// ---- the family's loan, and what paying down does for certain
const LOAN = 400000, EXTRA = 800, RATE = 7;
const r7 = RATE / 1200, pay7 = LOAN * r7 / (1 - (1 + r7) ** -360);
let bal = LOAN, paid = 0, payoffMonths = 0;
while (bal > 1e-6) { const due = bal * (1 + r7); const p = Math.min(due, pay7 + EXTRA); bal = due - p; paid += p; payoffMonths += 1; }
const saved = pay7 * 360 - paid;
says("N00", "four hundred thousand dollars, at seven percent", LOAN === 400000 && RATE === 7, "loan");
says("N00", "about twenty-seven hundred a month", Math.round(pay7 / 100) === 27, `$${pay7.toFixed(0)}`);
says("N02", "about sixteen years", Math.round(payoffMonths / 12) === 16, `${payoffMonths} months`);
says("N02", "two hundred ninety thousand dollars", K10(saved) === 290, `$${saved.toFixed(0)}`);

// ---- replay one: September 1972
const S72 = "1972-09", S93 = "1993-06";
const r72 = play(rateBy.get(S72), at.get(S72), 360, EXTRA, LOAN), r93 = play(rateBy.get(S93), at.get(S93), 360, EXTRA, LOAN);
const y72 = (n) => r72.year[n], y93 = (n) => r93.year[n];
const oneDp = (v) => Math.round(v * 10) / 10;
says("N03", "September nineteen seventy-two", S72 === "1972-09", "start");
says("N03", "about seven point four percent", oneDp(r72.pct) === 7.4, `${r72.pct}`);
says("M03", "Nineteen seventy-four", addMonths(S72, 24).startsWith("1974"), addMonths(S72, 24));
says("M03", "The market crashed", sh[at.get("1974-09")].tr < sh[at.get("1973-01")].tr * 0.7, `1973-01 to 1974-09 total return x${(sh[at.get("1974-09")].tr / sh[at.get("1973-01")].tr).toFixed(2)}`);
says("M03", "eleven thousand", K(y72(2).invPort) === 11, `$${y72(2).invPort.toFixed(0)}`);
says("L02", "seventeen thousand less", K(y72(2).invBal - y72(2).preBal) === 17, `$${(y72(2).invBal - y72(2).preBal).toFixed(0)}`);
says("L03", "Nineteen eighty-eight. House paid off", addMonths(S72, r72.payoff).startsWith("1988") && y72(16).preBal === 0, `payoff ${addMonths(S72, r72.payoff)}`);
says("M04", "a hundred two thousand", K(y72(16).invBal) === 102, `$${y72(16).invBal.toFixed(0)}`);
says("M04", "a hundred seventy-nine thousand", K(y72(16).invPort) === 179, `$${y72(16).invPort.toFixed(0)}`);
says("M05", "Two thousand two", addMonths(S72, 360).startsWith("2002"), addMonths(S72, 360));
says("M05", "five hundred eighty-seven thousand", K(r72.inv) === 587, `$${r72.inv.toFixed(0)}`);
says("L04", "Two hundred sixty-five thousand", K(r72.pre) === 265, `$${r72.pre.toFixed(0)}`);
says("N04", "three hundred twenty thousand dollars", K10(r72.gap) === 320 && r72.gap > 0, `$${r72.gap.toFixed(0)}`);

// ---- replay two: June 1993
says("N05", "twenty-one years later", 1993 - 1972 === 21, "years");
says("N05", "June nineteen ninety-three", S93 === "1993-06", "start");
says("N05", "also about seven point four percent", oneDp(r93.pct) === 7.4, `${r93.pct}`);
says("M07", "Two thousand", addMonths(S93, 84).startsWith("2000"), addMonths(S93, 84));
says("M07", "A hundred twenty-six thousand", K(y93(7).invPort) === 126, `$${y93(7).invPort.toFixed(0)}`);
says("M08", "Two thousand nine", addMonths(S93, 192).startsWith("2009"), addMonths(S93, 192));
says("M08", "the same hundred twenty-six thousand", K(y93(16).invPort) === 126, `$${y93(16).invPort.toFixed(0)}`);
says("M08", "still owe a hundred ninety-four", K(y93(16).invBal) === 194, `$${y93(16).invBal.toFixed(0)}`);
check(addMonths(S93, r93.payoff).startsWith("2009") && y93(16).preBal === 0, `L05 paid off by 2009: ${addMonths(S93, r93.payoff)}`);
says("N06", "Twenty twenty-three", addMonths(S93, 360).startsWith("2023"), addMonths(S93, 360));
says("N06", "Lan's way wins", r93.gap < 0, `gap ${r93.gap.toFixed(0)}`);
says("N06", "seven hundred forty-six thousand", K(r93.pre) === 746, `$${r93.pre.toFixed(0)}`);
says("N06", "to seven hundred ten", K(r93.inv) === 710, `$${r93.inv.toFixed(0)}`);
says("N07", "Minh wins by three hundred twenty thousand", K10(r72.gap) === 320, `$${r72.gap.toFixed(0)}`);
says("N07", "Lan wins by thirty-six", K(-r93.gap) === 36, `$${(-r93.gap).toFixed(0)}`);

// ---- every start at a fixed rate
const fixedAll = (pct) => { const out = []; for (let i = 0; i < sh.length; i += 1) { const x = play(pct, i, 360, EXTRA, LOAN); if (x) out.push(x); } return out; };
const by = Object.fromEntries([3, 4, 5, 6, 7, 8].map((p) => [p, fixedAll(p)]));
const winRate = (runs) => runs.filter((x) => x.gap > 0).length / runs.length;
const all7 = by[7], wins7 = all7.filter((x) => x.gap > 0).map((x) => x.gap), losses7 = all7.filter((x) => x.gap <= 0).map((x) => -x.gap);
says("N08", "since eighteen seventy-one", all7[0].m === "1871-01", all7[0].m);
says("N08", "fifteen hundred and six", all7.length === 1506, `${all7.length}`);
says("N09", "ahead about seven times in ten", Math.round(winRate(all7) * 10) === 7, `${(winRate(all7) * 100).toFixed(1)}%`);
says("N09", "usually won by about a hundred twenty thousand dollars", K10(median(wins7)) === 120, `$${median(wins7).toFixed(0)}`);
says("N09", "usually lost by about sixty thousand", K10(median(losses7)) === 60, `$${median(losses7).toFixed(0)}`);

// real signing months in the 7-8% band
const band = [];
for (let i = 0; i < sh.length; i += 1) {
  const rate = rateBy.get(sh[i].m);
  if (rate === undefined || rate < 7 || rate >= 8) continue;
  const x = play(rate, i, 360, EXTRA, LOAN);
  if (x) band.push(x);
}
const seventies = band.filter((x) => x.m < "1980"), nineties = band.filter((x) => x.m >= "1990");
says("N10", "Together, about six in ten", Math.round(winRate(band) * 10) === 6, `${band.filter((x) => x.gap > 0).length}/${band.length}`);
says("N10", "that happened in two stretches", seventies.length + nineties.length === band.length, "band is two eras only");
says("N10", "seven to eight percent", band.every((x) => x.pct >= 7 && x.pct < 8), "band limits");
says("N10", "early seventies, investing won all twenty-seven months", seventies.length === 27 && seventies.every((x) => x.gap > 0 && x.m < "1974"), `${seventies.filter((x) => x.gap > 0).length}/${seventies.length}`);
says("N10", "in the nineties, only about one in four", winRate(nineties) >= 0.2 && winRate(nineties) <= 0.3 && nineties.every((x) => x.m < "2000"), `${nineties.filter((x) => x.gap > 0).length}/${nineties.length}`);

// the ladder
says("N11", "three, four, even five percent, it won every single time", [3, 4, 5].every((p) => winRate(by[p]) === 1), [3, 4, 5].map((p) => winRate(by[p])).join(","));
says("N11", "The higher the rate, the more paying it off saves you", [3, 4, 5, 6, 7].every((p) => winRate(by[p + 1]) <= winRate(by[p])), "win rate never rises with the rate");
says("N11", "At six, more than nine times in ten", winRate(by[6]) > 0.9 && winRate(by[6]) < 1, `${winRate(by[6])}`);
says("N11", "At seven, about seven in ten", Math.round(winRate(by[7]) * 10) === 7, `${winRate(by[7])}`);
says("N11", "At eight, less than half", winRate(by[8]) < 0.5, `${winRate(by[8])}`);
says("N15", "At five percent or below, investing won every time", [3, 4, 5].every((p) => winRate(by[p]) === 1), "ladder");
says("N15", "At eight, it won less than half", winRate(by[8]) < 0.5, "ladder");

// worst and best, and the tie
says("N12", "about two hundred sixty thousand dollars", K10(Math.max(...losses7)) === 260, `$${Math.max(...losses7).toFixed(0)}`);
says("N12", "about eight hundred eighty thousand", K10(Math.max(...wins7)) === 880, `$${Math.max(...wins7).toFixed(0)}`);
function tieReturn() {
  let lo = 0, hi = 0.3;
  for (let it = 0; it < 80; it += 1) {
    const a = (lo + hi) / 2, g = (1 + a) ** (1 / 12);
    let ib = LOAN, ip = 0, pb = LOAN, pp = 0;
    for (let k = 0; k < 360; k += 1) {
      if (ib > 0) ib = Math.max(0, ib + ib * r7 - pay7);
      ip = (ip + (ib > 0 ? EXTRA : pay7 + EXTRA)) * g;
      if (pb > 0) { pb = pb + pb * r7 - pay7 - EXTRA; if (pb <= 0) { pp = (pp - pb) * g; pb = 0; } else pp *= g; } else pp = (pp + pay7 + EXTRA) * g;
    }
    if (ip - ib > pp - pb) hi = a; else lo = a;
  }
  return hi;
}
const tie = tieReturn();
says("N12", "about seven point two percent", oneDp(tie * 100) === 7.2, `${(tie * 100).toFixed(3)}%`);

// half and half, a separate ledger: each month the payment plus half the extra goes to the loan
function split(i0) {
  const n = 360;
  let b = LOAN, p = 0;
  for (let k = 0; k < n; k += 1) {
    const g = sh[i0 + k + 1].tr / sh[i0 + k].tr;
    let cash = pay7 + EXTRA;
    if (b > 0) { const due = b * (1 + r7), toLoan = Math.min(due, pay7 + EXTRA / 2); b = due - toLoan; cash -= toLoan; if (b < 1e-9) b = 0; }
    p = (p + cash) * g;
  }
  return (p - b) / (sh[i0 + n].cpi / sh[i0].cpi);
}
let top = 0, bottom = 0, between = 0;
for (const x of all7) {
  const s = split(at.get(x.m)), hi = Math.max(x.inv, x.pre), lo = Math.min(x.inv, x.pre);
  if (s > hi) top += 1; else if (s < lo) bottom += 1; else between += 1;
}
says("N14", "About two times in three, half and half lands between", Math.abs(between / all7.length - 2 / 3) < 0.03, `${between}/${all7.length}`);
says("N14", "About one time in four, it ended with less money than both", Math.abs(bottom / all7.length - 1 / 4) < 0.03, `${bottom}/${all7.length}`);
says("N14", "About one time in ten, it ended with more than both", Math.abs(top / all7.length - 1 / 10) < 0.02, `${top}/${all7.length}`);
console.log(`half and half: between ${between}, less than both ${bottom}, more than both ${top}, of ${all7.length}`);

// lessons
const ratio = median(wins7) / median(losses7);
says("N16", "investing usually won", winRate(all7) > 0.5, `${winRate(all7)}`);
says("N16", "about twice its typical loss", ratio > 1.8 && ratio < 2.3, `${ratio.toFixed(2)}`);
says("N17", "the smaller, surer win", median(losses7) < median(wins7), "typical pay-down win is the smaller one");

// Every line with a number word must be one the claims above know about.
const numberWords = /\b(hundred|thousand|million|percent|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|nineteen|eleven|fifteen|sixteen|seventeen|eighteen|seven|six|five|four|three)\b/i;
const claimed = new Set(["N00", "N02", "N03", "M03", "L02", "L03", "M04", "M05", "L04", "N04", "N05", "M07", "M08", "N06", "N07", "N08", "N09", "N10", "N11", "N12", "N14", "N15", "N16", "N17"]);
// lines that only restate the family's terms or a callback, no data claim
const termsOnly = new Set(["N01", "M01", "L01", "M10", "L07", "T02", "L09", "M13", "N18"]);
for (const l of script.lines) {
  if (numberWords.test(l.text) && !claimed.has(l.id) && !termsOnly.has(l.id)) failures.push(`${l.id} speaks a number no claim checks: "${l.text}"`);
}
check(line("N01").includes("eight hundred dollars") && EXTRA === 800, "N01 extra");
check(line("L09").includes("Four hundred") && line("M13").includes("Four hundred") && EXTRA / 2 === 400, "L09/M13 split");
check(line("L07").includes("Seven times out of ten") && Math.round(winRate(all7) * 10) === 7, "L07");

// ---- the 9:16 Short: same replays, its own words
ssays("S01", "eight hundred a month", EXTRA === 800, "extra");
ssays("S01", "about seven point four percent", oneDp(r72.pct) === 7.4 && oneDp(r93.pct) === 7.4, "both starts");
ssays("S02", "A hundred twenty-six thousand", K(y93(7).invPort) === 126, `$${y93(7).invPort.toFixed(0)}`);
ssays("S03", "Two thousand nine. My house is paid off", addMonths(S93, r93.payoff).startsWith("2009"), "payoff");
ssays("S04", "the same hundred twenty-six thousand", K(y93(16).invPort) === 126, `$${y93(16).invPort.toFixed(0)}`);
ssays("S04", "still owe a hundred ninety-four", K(y93(16).invBal) === 194, `$${y93(16).invBal.toFixed(0)}`);
ssays("S05", "Twenty twenty-three", addMonths(S93, 360).startsWith("2023"), "end");
ssays("S05", "by about thirty-six thousand", K(-r93.gap) === 36, `$${(-r93.gap).toFixed(0)}`);
ssays("S06", "in nineteen seventy-two", S72.startsWith("1972"), "start");
ssays("S07", "Nineteen seventy-four", addMonths(S72, 24).startsWith("1974"), "y2");
ssays("S07", "eleven thousand", K(y72(2).invPort) === 11, `$${y72(2).invPort.toFixed(0)}`);
ssays("S08", "Nineteen eighty-eight. My house is paid off", addMonths(S72, r72.payoff).startsWith("1988"), "payoff");
ssays("S09", "Two thousand two", addMonths(S72, 360).startsWith("2002"), "end");
ssays("S09", "by about three hundred twenty thousand", K10(r72.gap) === 320, `$${r72.gap.toFixed(0)}`);
ssays("S10", "since eighteen seventy-one, at seven percent", all7[0].m === "1871-01", all7[0].m);
ssays("S10", "about seven in ten", Math.round(winRate(all7) * 10) === 7, `${winRate(all7)}`);
ssays("S10", "At five percent or below, every time", [3, 4, 5].every((p) => winRate(by[p]) === 1), "ladder");
ssays("S10", "At eight, less than half", winRate(by[8]) < 0.5, "ladder");

// ---- the vertical full episode: same numbers, its own words, and it must fit a Short
const vertical = JSON.parse(await readFile(join(ep, "nguyens-vertical", "lines.json"), "utf8"));
const vline = (id) => vertical.lines.find((l) => l.id === id)?.text.replace(/\*/g, "") ?? "";
const vsays = (id, phrase, ok, detail) => {
  check(vline(id).includes(phrase), `vertical ${id} no longer says "${phrase}"`);
  check(ok, `vertical ${id} "${phrase}" is false: ${detail}`);
};
vsays("V01", "four hundred thousand dollar mortgage at seven percent", LOAN === 400000 && RATE === 7, "loan");
vsays("V01", "extra eight hundred dollars a month", EXTRA === 800, "extra");
vsays("V02", "in about sixteen years, not thirty", Math.round(payoffMonths / 12) === 16, `${payoffMonths} months`);
vsays("V05", "about seven point four percent", oneDp(r72.pct) === 7.4 && oneDp(r93.pct) === 7.4, "both starts");
vsays("V06", "June nineteen ninety-three", S93 === "1993-06", "start");
vsays("V07", "A hundred twenty-six thousand", K(y93(7).invPort) === 126, `$${y93(7).invPort.toFixed(0)}`);
vsays("V08", "Two thousand nine. My house is paid off", addMonths(S93, r93.payoff).startsWith("2009"), "payoff");
vsays("V09", "the same hundred twenty-six thousand", K(y93(16).invPort) === 126, `$${y93(16).invPort.toFixed(0)}`);
vsays("V09", "still owe a hundred ninety-four", K(y93(16).invBal) === 194, `$${y93(16).invBal.toFixed(0)}`);
vsays("V10", "Twenty twenty-three. Both houses are paid off", addMonths(S93, 360).startsWith("2023") && y93(30).invBal < 1 && y93(30).preBal < 1, "y30");
vsays("V10", "Lan has seven hundred forty-six thousand", K(r93.pre) === 746, `$${r93.pre.toFixed(0)}`);
vsays("V10", "Minh seven hundred ten", K(r93.inv) === 710, `$${r93.inv.toFixed(0)}`);
vsays("V10", "by thirty-six thousand", K(-r93.gap) === 36 && r93.gap < 0, `$${(-r93.gap).toFixed(0)}`);
vsays("V11", "twenty-one years earlier. September nineteen seventy-two", S72 === "1972-09" && 1993 - 1972 === 21, "start");
vsays("V12", "Nineteen seventy-four. The market crashed", sh[at.get("1974-09")].tr < sh[at.get("1973-01")].tr * 0.7, "1973-74 fall");
vsays("V12", "eleven thousand", K(y72(2).invPort) === 11, `$${y72(2).invPort.toFixed(0)}`);
vsays("V13", "Nineteen eighty-eight. My house is paid off", addMonths(S72, r72.payoff).startsWith("1988"), "payoff");
vsays("V14", "a hundred two thousand", K(y72(16).invBal) === 102, `$${y72(16).invBal.toFixed(0)}`);
vsays("V14", "a hundred seventy-nine thousand", K(y72(16).invPort) === 179, `$${y72(16).invPort.toFixed(0)}`);
vsays("V15", "Two thousand two. Minh has five hundred eighty-seven thousand", addMonths(S72, 360).startsWith("2002") && K(r72.inv) === 587, `$${r72.inv.toFixed(0)}`);
vsays("V15", "Lan two hundred sixty-five", K(r72.pre) === 265, `$${r72.pre.toFixed(0)}`);
vsays("V15", "by about three hundred twenty thousand", K10(r72.gap) === 320 && r72.gap > 0, `$${r72.gap.toFixed(0)}`);
vsays("V16", "since eighteen seventy-one", all7[0].m === "1871-01", all7[0].m);
vsays("V16", "fifteen hundred and six", all7.length === 1506, `${all7.length}`);
vsays("V17", "ahead about seven times in ten", Math.round(winRate(all7) * 10) === 7, `${winRate(all7)}`);
vsays("V17", "usually won by about a hundred twenty thousand dollars", K10(median(wins7)) === 120, `$${median(wins7).toFixed(0)}`);
vsays("V17", "usually lost by about sixty thousand", K10(median(losses7)) === 60, `$${median(losses7).toFixed(0)}`);
vsays("V18", "At five percent or lower: every single time", [3, 4, 5].every((p) => winRate(by[p]) === 1), "ladder");
vsays("V18", "At six: more than nine in ten", winRate(by[6]) > 0.9 && winRate(by[6]) < 1, `${winRate(by[6])}`);
vsays("V18", "At seven: about seven in ten", Math.round(winRate(by[7]) * 10) === 7, `${winRate(by[7])}`);
vsays("V18", "At eight: less than half", winRate(by[8]) < 0.5, `${winRate(by[8])}`);
vsays("V18", "The higher the rate, the more paying it off saves you", [3, 4, 5, 6, 7].every((p) => winRate(by[p + 1]) <= winRate(by[p])), "win rate never rises with the rate");
vsays("V20", "About two times in three, it ended between", Math.abs(between / all7.length - 2 / 3) < 0.03, `${between}/${all7.length}`);
vsays("V20", "about one time in four, it ended with less money than both", Math.abs(bottom / all7.length - 1 / 4) < 0.03, `${bottom}/${all7.length}`);
vsays("V21", "Around seven percent, investing usually won", winRate(all7) > 0.5, `${winRate(all7)}`);
vsays("V21", "the smaller, surer win", median(losses7) < median(wins7), "typical pay-down win is the smaller one");
const vClaimed = new Set(["V01", "V02", "V05", "V06", "V07", "V08", "V09", "V10", "V11", "V12", "V13", "V14", "V15", "V16", "V17", "V18", "V20", "V21"]);
const vTermsOnly = new Set(["V03"]);
for (const l of vertical.lines) {
  if (numberWords.test(l.text) && !vClaimed.has(l.id) && !vTermsOnly.has(l.id)) failures.push(`vertical ${l.id} speaks a number no claim checks: "${l.text}"`);
}

if (failures.length) {
  console.error(`validate-ep08-story: ${failures.length} FAIL of ${checks}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`validate-ep08-story: ${checks}/${checks} PASS (${all7.length} starts per rate, ${band.length} real 7-8% loans, ${doors ? "bridge to doors.json held" : "bridge skipped, doors.json absent"})`);
}
