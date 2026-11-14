#!/usr/bin/env node
// Independent check of every number the ep09 "The Nguyens: Wait for a Dip?" scripts speak.
//
//   node tools/validate-ep09-story.mjs
//
// Reads ONLY the pinned Shiller CSV and the narration of record (nguyens/lines.json,
// nguyens-vertical/lines.json). The ledger is written here from the CSV, not imported
// from the renderer. Conventions (also in the scripts' panel):
//   - real dollars: realTotalReturnPrice is already inflation-adjusted, so a constant
//     $500 is $500 of the window's last month (for the replays, June 2026 = "today");
//   - a contribution lands at month k's close and earns month k -> k+1;
//   - "the record" is the running maximum of the nominal monthly-average S&P price
//     since 1871, including month k; Uncle Tu buys when price_k <= (1 - X) * record_k,
//     investing all saved cash; otherwise the $500 waits in cash, which keeps its real value.
// For each claim it checks (1) the number is what the data says at the rounding the line
// uses and (2) the line still says it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const ep = join(root, "episodes", "ep09-wait-for-a-dip");
const parse = (text) => {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
};
const [shillerCsv, script, vertical] = await Promise.all([
  readFile(join(root, "data", "snapshots", "shiller-2026-07-26", "shiller-monthly.csv"), "utf8").then(parse),
  readFile(join(ep, "nguyens", "lines.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "nguyens-vertical", "lines.json"), "utf8").then(JSON.parse),
]);

let checks = 0;
const failures = [];
const check = (ok, what) => { checks += 1; if (!ok) failures.push(what); };
const textOf = (doc, id) => doc.lines.find((l) => l.id === id)?.text.replace(/\*/g, "") ?? "";
const says = (id, phrase, ok, detail) => {
  check(textOf(script, id).includes(phrase), `${id} no longer says "${phrase}"`);
  check(ok, `${id} "${phrase}" is false: ${detail}`);
};
const vsays = (id, phrase, ok, detail) => {
  check(textOf(vertical, id).includes(phrase), `vertical ${id} no longer says "${phrase}"`);
  check(ok, `vertical ${id} "${phrase}" is false: ${detail}`);
};

const sh = shillerCsv.filter((r) => r.cpi !== "" && Number.isFinite(Number(r.cpi)) && r.price !== "")
  .map((r) => ({ m: r.date, price: Number(r.price), real: Number(r.realTotalReturnPrice) }));
{ let rec = -Infinity; for (const r of sh) { rec = Math.max(rec, r.price); r.dd = r.price / rec - 1; r.atRecord = r.price >= rec; } }
const at = new Map(sh.map((r, i) => [r.m, i]));
const last = sh.length - 1;
check(sh[last].m === "2026-06", `snapshot ends ${sh[last].m}, scripts say June 2026`);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), h = 0.5 * (s.length - 1), lo = Math.floor(h), hi = Math.ceil(h); return s[lo] + (h - lo) * (s[hi] - s[lo]); };
const K = (v) => Math.round(v / 1000);
const K10 = (v) => Math.round(v / 10000) * 10;
const PAY = 500;

// One window: `months` paychecks starting at index i0, Uncle Tu waiting for an X drop.
function run(i0, months, X) {
  let minh = 0, tuStock = 0, tuCash = 0, cashMonths = 0, maxCash = 0;
  const state = [{ minh: 0, tu: 0, cash: 0, put: 0 }];
  for (let k = 0; k < months; k += 1) {
    const r = sh[i0 + k], g = sh[i0 + k + 1].real / r.real;
    minh = (minh + PAY) * g;
    tuCash += PAY;
    let put = 0;
    if (r.price <= (1 - X) * (r.price / (1 + r.dd))) { put = tuCash; tuStock += tuCash; tuCash = 0; }
    if (tuCash > 0) cashMonths += 1;
    maxCash = Math.max(maxCash, tuCash);
    tuStock *= g;
    state.push({ minh, tu: tuStock + tuCash, cash: tuCash, put });
  }
  const end = state.at(-1);
  return { m: sh[i0].m, state, minh: end.minh, tu: end.tu, gap: end.tu - end.minh, cashMonths, maxCash };
}
// money Tu put in when he bought at month index k (state[k + 1].put)
const putAt = (R, k) => R.state[k + 1].put;

// ---- kitchen
const recs2026 = sh.filter((r) => r.m.startsWith("2026") && r.atRecord).length;
says("N00", "Five hundred dollars a month", PAY === 500, "paycheck");
says("N00", "record after record this year", recs2026 >= 2, `${recs2026} record months in 2026 in the snapshot`);
says("T02", "ten percent below its record", true, "the rule, by definition");
says("N01", "at least ten percent below its record", true, "the rule, by definition");

// ---- replay one: January 2018 to June 2026
const S18 = at.get("2018-01"), R18 = run(S18, last - S18, 0.1);
says("N02", "January twenty eighteen. Stocks at a record", sh[S18].atRecord, `dd ${sh[S18].dd}`);
says("N02", "Same five hundred a month", PAY === 500, "paycheck");
says("T04", "December twenty eighteen. The market is down more than ten percent", sh[S18 + 11].m === "2018-12" && sh[S18 + 11].dd < -0.1, `${sh[S18 + 11].m} dd ${(sh[S18 + 11].dd * 100).toFixed(1)}%`);
says("T04", "six thousand dollars", putAt(R18, 11) === 6000 && R18.state.slice(1, 12).every((s) => s.put === 0), `put ${putAt(R18, 11)}`);
says("T05", "March twenty twenty", sh[S18 + 26].m === "2020-03", sh[S18 + 26].m);
says("T05", "I buy again: seven thousand", putAt(R18, 26) === 7000 && R18.state.slice(14, 27).every((s) => s.put === 0), `put ${putAt(R18, 26)}`);
says("T06", "Twenty twenty-two. Another drop", sh[S18 + 52].m.startsWith("2022") && sh[S18 + 52].dd < -0.1, sh[S18 + 52].m);
says("T06", "Twelve thousand goes in", putAt(R18, 52) === 12000, `put ${putAt(R18, 52)}`);
says("N03", "June twenty twenty-six", sh[last].m === "2026-06", sh[last].m);
says("N03", "Uncle Tu has eighty-seven thousand", K(R18.tu) === 87, `$${R18.tu.toFixed(0)}`);
says("N03", "Minh, eighty-five", K(R18.minh) === 85, `$${R18.minh.toFixed(0)}`);
says("N03", "by about two thousand dollars", K(R18.gap) === 2 && R18.gap > 0, `$${R18.gap.toFixed(0)}`);

// ---- replay two: October 2007 to June 2026
const S07 = at.get("2007-10"), R07 = run(S07, last - S07, 0.1);
// worst fall from a running high, with the high restarted at `a` (so the 1929 peak does not
// count against the 1940s-2000s): 2007-09 must be deeper than any fall from 1940 on.
const minIn = (a, b) => { let hi = -Infinity, worst = 0; for (const r of sh) { if (r.m < a || r.m > b) continue; hi = Math.max(hi, r.price); worst = Math.min(worst, r.price / hi - 1); } return worst; };
says("N04", "October two thousand seven. Another record", sh[S07].atRecord, `dd ${sh[S07].dd}`);
says("N04", "the worst crash since the Great Depression", minIn("2007-10", "2009-12") < minIn("1940-01", "2007-09"), `2008-09 ${minIn("2007-10", "2009-12").toFixed(3)} vs 1940-2007 ${minIn("1940-01", "2007-09").toFixed(3)}`);
says("T08", "January two thousand eight. Ten percent down. I buy", sh[S07 + 3].m === "2008-01" && sh[S07 + 3].dd <= -0.1 && putAt(R07, 3) > 0 && [0, 1, 2].every((k) => putAt(R07, k) === 0), `${sh[S07 + 3].m} dd ${sh[S07 + 3].dd.toFixed(3)}`);
const m09 = R07.state[17];
says("N05", "March two thousand nine", sh[S07 + 17].m === "2009-03", sh[S07 + 17].m);
says("N05", "the market is about half its record", Math.abs(sh[S07 + 17].dd + 0.5) < 0.05, `dd ${sh[S07 + 17].dd.toFixed(3)}`);
says("N05", "Both have put in eighty-five hundred dollars", 17 * PAY === 8500 && R07.state.slice(1, 18).reduce((a, s) => a + s.put, 0) + m09.cash === 8500, "17 paychecks");
says("N05", "both have less than six thousand left", m09.minh < 6000 && m09.tu < 6000, `Minh $${m09.minh.toFixed(0)}, Tu $${m09.tu.toFixed(0)}`);
says("N05", "Minh's way is down by about a third", Math.abs(1 - m09.minh / 8500 - 1 / 3) < 0.04, `${((1 - m09.minh / 8500) * 100).toFixed(1)}%`);
says("T09", "Twenty thirteen. A new record. I stop buying", sh[S07 + 72].m.startsWith("2013") && sh[S07 + 71].atRecord && R07.state.slice(60, 135).every((s) => s.put === 0), `${sh[S07 + 72].m}`);
// the cash pile: last buy before 2013, next buy December 2018
let lastBuy = -1; for (let k = 0; k < 72; k += 1) if (putAt(R07, k) > 0) lastBuy = k;
const pileMonths = 134 - (lastBuy + 1);
says("N06", "For more than six years", pileMonths > 72 && Array.from({ length: pileMonths }, (_, j) => putAt(R07, lastBuy + 1 + j)).every((p) => p === 0), `${pileMonths} months without buying, from ${sh[S07 + lastBuy + 1].m}`);
// the pile on screen in December 2018, before that month's paycheck and the buy
says("N06", "piled up in cash: thirty-eight thousand dollars", R07.state[134].cash === 38000 && R07.state[134].cash === Math.max(...R07.state.map((s) => s.cash)), `cash ${R07.state[134].cash}`);
says("N06", "the market just kept setting records", sh.slice(S07 + lastBuy + 1, S07 + 134).filter((r) => r.atRecord).length >= 24, `${sh.slice(S07 + lastBuy + 1, S07 + 134).filter((r) => r.atRecord).length} record months in the pile`);
says("T10", "December twenty eighteen. Finally, a drop. Everything goes in", sh[S07 + 134].m === "2018-12" && putAt(R07, 134) > 0 && R07.state[135].cash === 0, sh[S07 + 134].m);
says("N07", "Minh has three hundred fifty-five thousand", K(R07.minh) === 355, `$${R07.minh.toFixed(0)}`);
says("N07", "Uncle Tu, three hundred thirty", K(R07.tu) === 330, `$${R07.tu.toFixed(0)}`);
says("N07", "by about twenty-five thousand dollars", K(-R07.gap) === 25 && R07.gap < 0, `$${(-R07.gap).toFixed(0)}`);
// "the crash didn't cost him": he was never behind Minh before the cash pile began
says("N08", "The crash didn't cost him. The six years in cash did", R07.state.slice(1, lastBuy + 2).every((s) => s.tu >= s.minh), "Tu at or ahead of Minh through 2012");
says("L02", "Uncle Tu wins by two thousand", K(R18.gap) === 2, "r18");
says("L02", "Minh wins by twenty-five", K(-R07.gap) === 25, "r07");

// ---- every 30-year window since 1871
const windows = (X) => { const o = []; for (let i = 0; i + 360 <= last; i += 1) o.push(run(i, 360, X)); return o; };
const W = { 10: windows(0.1), 20: windows(0.2), 30: windows(0.3) };
const all = W[10], wins = all.filter((x) => x.gap > 0), losses = all.filter((x) => x.gap <= 0);
console.log(`10% rule: Tu ahead ${wins.length}/${all.length}; typical win $${median(wins.map((x) => x.gap)).toFixed(0)}, typical loss $${median(losses.map((x) => -x.gap)).toFixed(0)}`);
says("N09", "since eighteen seventy-one", all[0].m === "1871-01", all[0].m);
says("N09", "fifteen hundred and six", all.length === 1506, `${all.length}`);
says("N09", "about five hundred sixty thousand dollars", K10(median(all.map((x) => x.minh))) === 560, `$${median(all.map((x) => x.minh)).toFixed(0)}`);
says("N10", "less than one time in four", wins.length / all.length < 0.25 && wins.length / all.length > 0.2, `${wins.length}/${all.length}`);
says("N10", "usually won by about four thousand dollars", K(median(wins.map((x) => x.gap))) === 4, `$${median(wins.map((x) => x.gap)).toFixed(0)}`);
says("N10", "usually lost by about twenty-five thousand", K(median(losses.map((x) => -x.gap))) === 25, `$${median(losses.map((x) => -x.gap)).toFixed(0)}`);
const best = Math.max(...wins.map((x) => x.gap)), worst = Math.max(...losses.map((x) => -x.gap));
says("N10", "best start ever won about seventy-five hundred", Math.round(best / 100) === 75, `$${best.toFixed(0)}`);
says("N10", "worst lost about a hundred sixty-four thousand", K(worst) === 164, `$${worst.toFixed(0)}`);

// ---- the ladder: typical (median over all windows) result of each rule, and time in cash
const typical = (X) => median(W[X].map((x) => x.gap));
const cashShare = (X) => median(W[X].map((x) => x.cashMonths / 360));
console.log(`ladder typical: ${[10, 20, 30].map((X) => `${X}% ${typical(X).toFixed(0)} (cash ${(cashShare(X) * 100).toFixed(1)}%)`).join(", ")}`);
says("N11", "Wait for ten percent: about eleven thousand dollars behind", K(-typical(10)) === 11 && typical(10) < 0, `$${typical(10).toFixed(0)}`);
says("N11", "Twenty percent: about twenty thousand", K(-typical(20)) === 20 && typical(20) < 0, `$${typical(20).toFixed(0)}`);
says("N11", "Thirty percent, a real crash: about sixty-six thousand behind", K(-typical(30)) === 66 && typical(30) < 0, `$${typical(30).toFixed(0)}`);
says("N11", "the more the wait cost", typical(10) > typical(20) && typical(20) > typical(30), "typical cost grows with the drop");
says("N11", "about eighty-five percent of the time", Math.round(cashShare(30) * 100) === 85, `${(cashShare(30) * 100).toFixed(1)}%`);
says("N15", "The bigger the crash you wait for, the more it cost", typical(10) > typical(20) && typical(20) > typical(30), "ladder");

// ---- lessons
const s60 = sh.filter((r) => r.m >= "1960-01"), recShare = s60.filter((r) => r.atRecord).length / s60.length;
says("N13", "Since nineteen sixty, about three months in ten set a new one", Math.round(recShare * 10) === 3, `${(recShare * 100).toFixed(1)}%`);
says("N14", "It won less than one time in four", wins.length / all.length < 0.25, "every");
says("N14", "usually by about four thousand dollars", K(median(wins.map((x) => x.gap))) === 4, "every");
says("N14", "usually by about twenty-five thousand", K(median(losses.map((x) => -x.gap))) === 25, "every");
says("N16", "Five hundred a month in today's money", PAY === 500, "paycheck");

// Every line with a number word must be one the claims above know about.
const numberWords = /\b(hundred|thousand|million|percent|half|third|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|nineteen|eighteen|seventeen|sixteen|fifteen|fourteen|thirteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two)\b/i;
const claimed = new Set(["N00", "T02", "N01", "N02", "T04", "T05", "T06", "N03", "N04", "T08", "N05", "T09", "N06", "T10", "N07", "N08", "L02", "N09", "N10", "N11", "N13", "N14", "N15", "N16"]);
const termsOnly = new Set(["M04", "T13"]); // "Two picks", "Ten percent is too small": restate the rule, no data claim
for (const l of script.lines) if (numberWords.test(l.text) && !claimed.has(l.id) && !termsOnly.has(l.id)) failures.push(`${l.id} speaks a number no claim checks: "${l.text}"`);
check(textOf(script, "T13").includes("Ten percent"), "T13 rule");
check(textOf(script, "M04").includes("Two picks"), "M04");

// ---- the vertical
vsays("V01", "Stocks keep hitting record highs", recs2026 >= 2, `${recs2026} record months in 2026`);
vsays("V01", "five hundred dollars a month", PAY === 500, "paycheck");
vsays("V02", "ten percent down", true, "the rule");
vsays("V05", "January twenty eighteen. A record", sh[S18].atRecord, "r18 start");
vsays("V06", "Twenty eighteen, twenty twenty, twenty twenty-two", ["2018-12", "2020-03", "2022-05"].every((m) => putAt(R18, at.get(m) - S18) > 0), "Tu's dip buys");
vsays("V07", "June twenty twenty-six", sh[last].m === "2026-06", "end");
vsays("V07", "by about two thousand dollars", K(R18.gap) === 2 && R18.gap > 0, `$${R18.gap.toFixed(0)}`);
vsays("V08", "October two thousand seven. Another record", sh[S07].atRecord, "r07 start");
vsays("V08", "the worst crash since the Great Depression", minIn("2007-10", "2009-12") < minIn("1940-01", "2007-09"), "crash");
vsays("V09", "March two thousand nine", sh[S07 + 17].m === "2009-03", "y");
vsays("V09", "down by about a third", Math.abs(1 - m09.minh / 8500 - 1 / 3) < 0.04, `${((1 - m09.minh / 8500) * 100).toFixed(1)}%`);
vsays("V10", "Twenty thirteen. A new record. I stop buying", sh[S07 + 72].m.startsWith("2013") && R07.state.slice(60, 135).every((s) => s.put === 0), "stop");
vsays("V11", "For more than six years", pileMonths > 72, `${pileMonths} months`);
vsays("V11", "piled up in cash: thirty-eight thousand dollars", R07.state[134].cash === 38000, `${R07.state[134].cash}`);
vsays("V12", "June twenty twenty-six", sh[last].m === "2026-06", "end");
vsays("V12", "Minh has three hundred fifty-five thousand", K(R07.minh) === 355, `$${R07.minh.toFixed(0)}`);
vsays("V12", "Uncle Tu three hundred thirty", K(R07.tu) === 330, `$${R07.tu.toFixed(0)}`);
vsays("V12", "by about twenty-five thousand", K(-R07.gap) === 25 && R07.gap < 0, `$${(-R07.gap).toFixed(0)}`);
vsays("V12", "The crash didn't cost Uncle Tu", R07.state.slice(1, lastBuy + 2).every((s) => s.tu >= s.minh), "crash");
vsays("V13", "since eighteen seventy-one", all[0].m === "1871-01", "first");
vsays("V13", "fifteen hundred and six", all.length === 1506, `${all.length}`);
vsays("V14", "Waiting won less than one time in four", wins.length / all.length < 0.25 && wins.length / all.length > 0.2, `${wins.length}/${all.length}`);
vsays("V14", "usually by about four thousand dollars", K(median(wins.map((x) => x.gap))) === 4, "every");
vsays("V14", "usually by about twenty-five thousand", K(median(losses.map((x) => -x.gap))) === 25, "every");
vsays("V15", "waiting for a bigger crash cost more", typical(10) > typical(20) && typical(20) > typical(30), "ladder");
vsays("V15", "Ten percent: about eleven thousand behind", K(-typical(10)) === 11, `${typical(10)}`);
vsays("V15", "Twenty: about twenty thousand", K(-typical(20)) === 20, `${typical(20)}`);
vsays("V15", "Thirty: about sixty-six thousand behind", K(-typical(30)) === 66, `${typical(30)}`);
vsays("V16", "since nineteen sixty, about three months in ten set one", Math.round(recShare * 10) === 3, `${recShare}`);
const vClaimed = new Set(["V01", "V02", "V05", "V06", "V07", "V08", "V09", "V10", "V11", "V12", "V13", "V14", "V15", "V16"]);
for (const l of vertical.lines) if (numberWords.test(l.text) && !vClaimed.has(l.id)) failures.push(`vertical ${l.id} speaks a number no claim checks: "${l.text}"`);

// ---- Short 2: the October 2007 story alone
const short = JSON.parse(await readFile(join(ep, "nguyens-short", "lines.json"), "utf8"));
const ssays = (id, phrase, ok, detail) => {
  check(textOf(short, id).includes(phrase), `short ${id} no longer says "${phrase}"`);
  check(ok, `short ${id} "${phrase}" is false: ${detail}`);
};
ssays("S01", "five hundred dollars a month", PAY === 500, "paycheck");
ssays("S01", "until the market is ten percent down", true, "the rule");
ssays("S02", "October two thousand seven. A record", sh[S07].atRecord, "start");
ssays("S02", "the worst crash since the Great Depression", minIn("2007-10", "2009-12") < minIn("1940-01", "2007-09"), "crash");
ssays("S03", "January two thousand eight. Ten percent down", sh[S07 + 3].m === "2008-01" && sh[S07 + 3].dd <= -0.1 && putAt(R07, 3) > 0, "first buy");
ssays("S04", "March two thousand nine", sh[S07 + 17].m === "2009-03", "y");
ssays("S04", "down by about a third", Math.abs(1 - m09.minh / 8500 - 1 / 3) < 0.04, `${((1 - m09.minh / 8500) * 100).toFixed(1)}%`);
ssays("S05", "Twenty thirteen. A new record. I stop buying", sh[S07 + 72].m.startsWith("2013") && R07.state.slice(60, 135).every((s) => s.put === 0), "stop");
ssays("S06", "For more than six years", pileMonths > 72, `${pileMonths} months`);
ssays("S06", "piled up in cash: thirty-eight thousand dollars", R07.state[134].cash === 38000, `${R07.state[134].cash}`);
ssays("S07", "June twenty twenty-six", sh[last].m === "2026-06", "end");
ssays("S07", "by about twenty-five thousand dollars", K(-R07.gap) === 25 && R07.gap < 0, `$${(-R07.gap).toFixed(0)}`);
ssays("S07", "The crash didn't cost Uncle Tu", R07.state.slice(1, lastBuy + 2).every((s) => s.tu >= s.minh), "crash");
ssays("S08", "since eighteen seventy-one", all[0].m === "1871-01", "first");
ssays("S08", "less than one time in four", wins.length / all.length < 0.25, `${wins.length}/${all.length}`);
for (const l of short.lines) if (numberWords.test(l.text) && !l.id.match(/^S0[1-8]$/)) failures.push(`short ${l.id} speaks a number no claim checks`);

if (failures.length) {
  console.error(`validate-ep09-story: ${failures.length} FAIL of ${checks}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`validate-ep09-story: ${checks}/${checks} PASS (${all.length} thirty-year windows, replays 2018-01 and 2007-10 to ${sh[last].m})`);
}
