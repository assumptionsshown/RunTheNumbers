#!/usr/bin/env node
// Independent check of every number the ep10 "The Nguyens: Social Security at 62 or 70?"
// scripts speak.
//
//   node tools/validate-ep10-story.mjs
//
// Reads ONLY pinned data (SSA claiming rules + 2023 period life table, Shiller CSV) and the
// narration of record (nguyens/, nguyens-vertical/, nguyens-short/ lines.json). The ledger is
// written here, not imported from a renderer. Conventions (also in the scripts' panel):
//   - all dollars are today's money: checks rise with prices (COLA), and the Shiller
//     realTotalReturnPrice is already inflation-adjusted;
//   - PIA $2,000 a month at full retirement age 67 (births 1960+); 62 = 70%, 70 = 124%;
//   - month k = k months after the 62nd birthday (age 62 + k/12); a check paid at month k;
//   - "collected by month m" = checks paid at months 0..m-1;
//   - life table: lx interpolated linearly between whole ages; survival from 62 = lx(a)/lx(62);
//   - Minh's way: months 0..95 every $1,400 check goes into stocks at month k's close; from
//     month 96 the pile pays a $1,080 top-up at each month's close (1,400 + 1,080 = 2,480);
//     the pile grows month k-1 -> k by the real total return; it RUNS OUT at the first month
//     it cannot pay the whole top-up.
// For each claim it checks (1) the number is what the data says at the rounding the line uses
// and (2) the line still says it.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const ep = join(root, "episodes", "ep10-social-security-62-or-70");
const parse = (text) => {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return rows.map((r) => Object.fromEntries(r.split(",").map((v, i) => [cols[i], v])));
};
const snap = join(root, "data", "snapshots");
const [shillerCsv, lifeCsv, rules, script, vertical, short] = await Promise.all([
  readFile(join(snap, "shiller-2026-07-26", "shiller-monthly.csv"), "utf8").then(parse),
  readFile(join(snap, "ssa-2026-11-13", "period-life-table-2023.csv"), "utf8").then(parse),
  readFile(join(snap, "ssa-2026-11-13", "claiming-rules.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "nguyens", "lines.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "nguyens-vertical", "lines.json"), "utf8").then(JSON.parse),
  readFile(join(ep, "nguyens-short", "lines.json"), "utf8").then(JSON.parse),
]);
const hook = JSON.parse(await readFile(join(ep, "nguyens-hook", "lines.json"), "utf8"));

let checks = 0;
const failures = [];
const check = (ok, what) => { checks += 1; if (!ok) failures.push(what); };
const textOf = (doc, id) => doc.lines.find((l) => l.id === id)?.text.replace(/\*/g, "") ?? "";
const sayer = (doc, tag) => (id, phrase, ok, detail) => {
  check(textOf(doc, id).includes(phrase), `${tag}${id} no longer says "${phrase}"`);
  check(ok, `${tag}${id} "${phrase}" is false: ${detail}`);
};
const says = sayer(script, ""), vsays = sayer(vertical, "vertical "), ssays = sayer(short, "short ");
const K = (v) => Math.round(v / 1000);
const K5 = (v) => Math.round(v / 5000) * 5;
const K10 = (v) => Math.round(v / 10000) * 10;
const near = (x, target, tol) => Math.abs(x - target) <= tol;

// ---- the checks
const PIA = 2000;
const pctOf = (age) => rules.percentOfPIA[String(age)];
const EARLY = PIA * pctOf(62) / 100, FRA = PIA * pctOf(67) / 100, LATE = PIA * pctOf(70) / 100, TOP = LATE - EARLY;
check(rules.normalRetirementAge === 67 && rules.birthYears === "1960 and later", "claiming rules are the 1960+ row");
check(EARLY === 1400 && FRA === 2000 && LATE === 2480 && TOP === 1080, `checks ${EARLY}/${FRA}/${LATE}`);
const collectedEarly = (m) => EARLY * m;
const collectedLate = (m) => LATE * Math.max(0, m - 96);
let breakEven = 97; while (collectedLate(breakEven) < collectedEarly(breakEven)) breakEven += 1;
const beAge = 62 + breakEven / 12;
console.log(`break-even: month ${breakEven}, age ${beAge.toFixed(2)}`);

// ---- life table
const life = lifeCsv.map((r) => ({ age: Number(r.age), m: Number(r.male_lx), f: Number(r.female_lx), me: Number(r.male_ex), fe: Number(r.female_ex) }));
check(life.length === 120 && life[0].m === 100000 && life[62].m === 82563 && life[62].f === 89767, "life table pinned values");
{
  const manifest = JSON.parse(await readFile(join(snap, "ssa-2026-11-13", "manifest.json"), "utf8"));
  const raw = await readFile(join(snap, "ssa-2026-11-13", "period-life-table-2023.csv"));
  const sha = createHash("sha256").update(raw).digest("hex");
  check(sha === manifest.files["period-life-table-2023.csv"].sha256, `life table sha256 ${sha} differs from manifest`);
}
const lx = (sex, a) => { const lo = Math.floor(a), f = a - lo; const v = (x) => life[Math.min(119, x)][sex]; return v(lo) * (1 - f) + v(lo + 1) * f; };
const surv = (sex, a) => lx(sex, a) / lx(sex, 62);
const lifetime = (sex, claimAge) => { const b = PIA * pctOf(claimAge) / 100; let s = 0; for (let k = (claimAge - 62) * 12; k < (119 - 62) * 12; k += 1) s += b * surv(sex, 62 + k / 12); return s; };
const gainM = lifetime("m", 70) - lifetime("m", 62), gainF = lifetime("f", 70) - lifetime("f", 62);
console.log(`survival to 80: men ${surv("m", 80).toFixed(3)}, women ${surv("f", 80).toFixed(3)}; to break-even men ${surv("m", beAge).toFixed(3)}; lifetime gain from waiting: men $${gainM.toFixed(0)}, women $${gainF.toFixed(0)}`);

// ---- Shiller and Minh's way
const sh = shillerCsv.filter((r) => r.cpi !== "" && Number.isFinite(Number(r.cpi)) && r.price !== "")
  .map((r) => ({ m: r.date, real: Number(r.realTotalReturnPrice) }));
const at = new Map(sh.map((r, i) => [r.m, i]));
const last = sh.length - 1;
check(sh[last].m === "2026-06", `snapshot ends ${sh[last].m}`);
function minhWay(i0, months) {
  const pile = []; let p = 0, runout = null;
  for (let k = 0; k <= months; k += 1) {
    if (k > 0) p *= sh[i0 + k].real / sh[i0 + k - 1].real;
    if (k === 96) var atSeventy = p;
    if (k < 96) p += EARLY;
    else if (p >= TOP) p -= TOP;
    else { if (runout == null) runout = k; p = 0; }
    pile.push(p);
  }
  return { m: sh[i0].m, pile, runout, atSeventy };
}
const ageOf = (k) => 62 + k / 12;
const R90 = minhWay(at.get("1990-01"), last - at.get("1990-01"));
const R00 = minhWay(at.get("2000-01"), last - at.get("2000-01"));
const windows = []; for (let i = 0; i + 456 <= last; i += 1) windows.push(minhWay(i, 455));
const lasted = windows.filter((w) => w.runout == null);
const before = (age) => windows.filter((w) => w.runout != null && ageOf(w.runout) < age);
const worst = windows.reduce((a, w) => ((w.runout ?? 1e9) < (a.runout ?? 1e9) ? w : a), windows[0]);
console.log(`Minh's way: ${windows.length} starts ${windows[0].m}..${windows.at(-1).m}; lasted to 100 ${lasted.length}; out before 90 ${before(90).length}, before 85 ${before(85).length}, before break-even ${before(beAge).length}; worst ${worst.m} at ${ageOf(worst.runout).toFixed(2)}`);
console.log(`1990: at 70 $${R90.atSeventy.toFixed(0)}, June 2026 $${R90.pile.at(-1).toFixed(0)}; 2000: 2002-09 $${R00.pile[32].toFixed(0)}, at 70 $${R00.atSeventy.toFixed(0)}, 2009-03 $${R00.pile[110].toFixed(0)}, runout ${sh[at.get("2000-01") + R00.runout].m} age ${ageOf(R00.runout).toFixed(2)}`);

// ---- kitchen
says("N00", "Uncle Tu turns sixty-two", true, "his birthday, the story's premise");
says("N01", "at sixty-two: fourteen hundred dollars a month", EARLY === 1400, `${EARLY}`);
says("N01", "Wait until sixty-seven: two thousand", FRA === 2000, `${FRA}`);
says("N01", "Wait until seventy: twenty-four hundred eighty", LATE === 2480, `${LATE}`);
says("N01", "Every year he waits, the check gets bigger", [62, 63, 64, 65, 66, 67, 68, 69, 70].every((a, i, xs) => i === 0 || pctOf(a) > pctOf(xs[i - 1])), "percent rises each year");
says("N01", "three point six percent", rules.cola2027.percent === 3.6, `${rules.cola2027.percent}`);
says("L01", "almost eighty percent more", LATE / EARLY - 1 > 0.75 && LATE / EARLY - 1 < 0.8, `${((LATE / EARLY - 1) * 100).toFixed(1)}%`);
says("T02", "still here at eighty", true, "his worry, sets up the break-even");
says("N02", "stops working at sixty-two", true, "assumption, in the panel");

// ---- the race
says("N04", "a hundred thirty-four thousand dollars", collectedEarly(96) === 134400, `${collectedEarly(96)}`);
says("N04", "Lan's way: zero", collectedLate(96) === 0, `${collectedLate(96)}`);
says("N05", "bigger, by one thousand eighty dollars", TOP === 1080, `${TOP}`);
says("N05", "A little past eighty, the two piles are even", beAge > 80 && beAge < 80.75 && breakEven === 221, `age ${beAge.toFixed(2)}`);
says("N06", "At ninety, Lan's way is ahead by about a hundred twenty-five thousand", K5(collectedLate(336) - collectedEarly(336)) === 125, `${collectedLate(336) - collectedEarly(336)}`);
says("L02", "waiting wins if you live past eighty", beAge > 80 && beAge < 81, `age ${beAge.toFixed(2)}`);

// ---- the people
says("N07", "a hundred men in the US who just turned sixty-two", true, "the 100 dots are the table's survivors per 100 at 62");
says("N08", "By eighty, about six in ten are still here", Math.round(surv("m", 80) * 10) === 6, `${surv("m", 80).toFixed(3)}`);
says("N08", "a man lives to about eighty-two", Math.round(62 + life[62].me) === 82, `e62 ${life[62].me}`);
says("N08", "For women, it's about seven in ten, and about eighty-five", Math.round(surv("f", 80) * 10) === 7 && Math.round(62 + life[62].fe) === 85, `${surv("f", 80).toFixed(3)}, e62 ${life[62].fe}`);
says("N09", "waiting until seventy paid men about forty thousand dollars more", K10(gainM) === 40, `$${gainM.toFixed(0)}`);
says("N09", "Women, about seventy thousand more", K10(gainF) === 70, `$${gainF.toFixed(0)}`);
says("T05", "if I die at seventy, I got nothing", collectedLate(96) === 0, "waiting has paid nothing by 70");
says("N10", "At ninety-five, Lan's way is ahead by about a hundred ninety thousand", K10(collectedLate(396) - collectedEarly(396)) === 190, `${collectedLate(396) - collectedEarly(396)}`);

// ---- Minh's plan and the replays
says("N11", "twenty-four eighty a month", EARLY + TOP === 2480, "top-up");
says("N11", "back to fourteen hundred, for life", EARLY === 1400, "early check");
says("N12", "turned sixty-two in January nineteen ninety", R90.m === "1990-01", R90.m);
says("N13", "By seventy, his pile is about two hundred seventy thousand", K10(R90.atSeventy) === 270, `$${R90.atSeventy.toFixed(0)}`);
says("N13", "He only put in a hundred thirty-four", 96 * EARLY === 134400, "96 checks");
says("N14", "June twenty twenty-six. He's ninety-eight", sh[at.get("1990-01") + 437].m === "2026-06" && Math.floor(ageOf(437)) === 98 && R90.pile.length === 438, `${sh[at.get("1990-01") + 437]?.m} age ${ageOf(437).toFixed(2)}`);
says("N14", "He took his top-up every single month", R90.runout == null, "no runout");
says("N14", "about two hundred thirty-six thousand", K(R90.pile[437]) === 236, `$${R90.pile[437].toFixed(0)}`);
says("N15", "January two thousand", R00.m === "2000-01", R00.m);
says("N16", "By fall twenty oh two, he's put in forty-six thousand", sh[at.get("2000-01") + 32].m === "2002-09" && K(33 * EARLY) === 46, `${sh[at.get("2000-01") + 32].m}, ${33 * EARLY}`);
says("N16", "the pile is worth about thirty-three thousand", K(R00.pile[32]) === 33, `$${R00.pile[32].toFixed(0)}`);
says("N17", "At seventy, about a hundred forty-nine thousand", K(R00.atSeventy) === 149 && R00.atSeventy > R00.pile[32], `$${R00.atSeventy.toFixed(0)}`);
says("N17", "Then, two thousand eight", sh[at.get("2000-01") + 96].m === "2008-01", sh[at.get("2000-01") + 96].m);
says("N18", "March two thousand nine. About seventy-two thousand left", sh[at.get("2000-01") + 110].m === "2009-03" && K(R00.pile[110]) === 72, `${sh[at.get("2000-01") + 110].m} $${R00.pile[110].toFixed(0)}`);
says("N18", "he still takes his top-up every month", R00.runout > 110, `runout ${R00.runout}`);
says("T06", "December twenty twenty-three. I'm almost eighty-six. The pile is empty", sh[at.get("2000-01") + R00.runout].m === "2023-12" && R00.runout === 287 && ageOf(287) > 85.5 && ageOf(287) < 86, `${sh[at.get("2000-01") + R00.runout].m} age ${ageOf(R00.runout).toFixed(2)}`);
says("N19", "Minh's way pays fourteen hundred a month. Lan's way pays twenty-four eighty", EARLY === 1400 && LATE === 2480, "checks");
says("L04", "the money runs out at eighty-six", Math.round(ageOf(R00.runout)) === 86, `${ageOf(R00.runout).toFixed(2)}`);

// ---- every start
says("N20", "since eighteen seventy-one", windows[0].m === "1871-01", windows[0].m);
says("N20", "fourteen hundred and ten starts", windows.length === 1410, `${windows.length}`);
const share = (xs) => xs.length / windows.length;
says("N21", "In a little under half, the money lasted to a hundred", share(lasted) > 0.4 && share(lasted) < 0.5, `${lasted.length}/${windows.length}`);
says("N21", "in about one in three, it ran out before ninety", near(share(before(90)), 1 / 3, 0.03), `${before(90).length}`);
says("N21", "About one in five, before eighty-five", near(share(before(85)), 1 / 5, 0.03), `${before(85).length}`);
says("N21", "The worst start: January nineteen sixty-six", worst.m === "1966-01", worst.m);
says("N21", "emptied the pile at seventy-eight", Math.floor(ageOf(worst.runout)) === 78, `${ageOf(worst.runout).toFixed(2)}`);
says("T08", "A hundred?", true, "Bin's card");

// ---- lessons and panel
says("N24", "The break-even is about eighty", Math.round(beAge) === 80, `${beAge}`);
says("N24", "about six in ten men, and seven in ten women", Math.round(surv("m", beAge) * 10) === 6 && Math.round(surv("f", beAge) * 10) === 7, `men ${surv("m", beAge).toFixed(3)}, women ${surv("f", beAge).toFixed(3)} past break-even`);
says("N26", "lasted to a hundred in a little under half of history", share(lasted) > 0.4 && share(lasted) < 0.5, "every");
says("N26", "about one time in three, it ran out before ninety", near(share(before(90)), 1 / 3, 0.03), "every");
says("N27", "two thousand dollars a month at sixty-seven", FRA === 2000 && rules.normalRetirementAge === 67, "PIA");
says("N27", "born in nineteen sixty or later", rules.birthYears === "1960 and later", rules.birthYears);
says("N27", "twenty twenty-three life table", true, "SSA 2023 period life table, 2026 Trustees Report (snapshot)");

// Every line with a number word must be one the claims above know about.
const numberWords = /\b(hundred|thousand|million|percent|half|third|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|nineteen|eighteen|seventeen|sixteen|fifteen|fourteen|thirteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one)\b/i;
const claimed = new Set(["N00", "N01", "L01", "T02", "N02", "N04", "N05", "N06", "L02", "N07", "N08", "N09", "T05", "N10", "N11", "N12", "N13", "N14", "N15", "N16", "N17", "N18", "T06", "N19", "L04", "N20", "N21", "T08", "N24", "N26", "N27"]);
// restate the setting, no data claim: ages 62/70 as the two choices, "Three ideas", "Two years"
const termsOnly = new Set(["T03", "N03", "L03", "M02", "T07", "N22", "N25", "N28", "T01", "M01", "M03", "T04", "N23", "L05"]);
for (const l of script.lines) if (numberWords.test(l.text) && !claimed.has(l.id) && !termsOnly.has(l.id)) failures.push(`${l.id} speaks a number no claim checks: "${l.text}"`);
for (const id of termsOnly) check(textOf(script, id).length > 0, `${id} missing`);

// ---- the vertical
vsays("V01", "take fourteen hundred a month now", EARLY === 1400, "early");
vsays("V01", "wait until seventy and get twenty-four hundred eighty", LATE === 2480, "late");
vsays("V03", "almost eighty percent more", LATE / EARLY - 1 > 0.75 && LATE / EARLY - 1 < 0.8, "ratio");
vsays("V05", "a hundred thirty-four thousand dollars. Waiting: zero", collectedEarly(96) === 134400 && collectedLate(96) === 0, "race at 70");
vsays("V06", "a thousand eighty dollars a month", TOP === 1080, "top");
vsays("V06", "A little past eighty, they're even", beAge > 80 && beAge < 80.75, `${beAge}`);
vsays("V07", "about six in ten live past eighty", Math.round(surv("m", 80) * 10) === 6, "men");
vsays("V07", "For women, about seven in ten", Math.round(surv("f", 80) * 10) === 7, "women");
vsays("V10", "January nineteen ninety", R90.m === "1990-01", "start");
vsays("V10", "At ninety-eight, the pile still has about two hundred thirty-six thousand", Math.floor(ageOf(437)) === 98 && K(R90.pile[437]) === 236 && R90.runout == null, `$${R90.pile[437].toFixed(0)}`);
vsays("V11", "January two thousand", R00.m === "2000-01", "start");
vsays("V12", "I'm almost eighty-six. The pile is empty", ageOf(R00.runout) > 85.5 && ageOf(R00.runout) < 86, `${ageOf(R00.runout)}`);
vsays("V13", "since eighteen seventy-one, fourteen hundred and ten of them", windows[0].m === "1871-01" && windows.length === 1410, `${windows.length}`);
vsays("V13", "lasted to a hundred a little under half the time", share(lasted) > 0.4 && share(lasted) < 0.5, "every");
vsays("V13", "About one in three, it ran out before ninety", near(share(before(90)), 1 / 3, 0.03), "every");
vsays("V14", "the break-even is about eighty, and most people live past it", Math.round(beAge) === 80 && surv("m", beAge) > 0.5 && surv("f", beAge) > 0.5, "break-even");
vsays("V15", "two thousand a month at sixty-seven", FRA === 2000, "PIA");
vsays("V15", "twenty twenty-three life table", true, "snapshot");
const vClaimed = new Set(["V01", "V03", "V05", "V06", "V07", "V10", "V11", "V12", "V13", "V14", "V15"]);
const vTerms = new Set(["V02", "V04", "V08", "V09", "V16"]);
for (const l of vertical.lines) if (numberWords.test(l.text) && !vClaimed.has(l.id) && !vTerms.has(l.id)) failures.push(`vertical ${l.id} speaks a number no claim checks: "${l.text}"`);

// ---- Short 2
ssays("S01", "fourteen hundred a month now", EARLY === 1400, "early");
ssays("S01", "twenty-four hundred eighty if he waits until seventy", LATE === 2480, "late");
ssays("S03", "a hundred thirty-four thousand dollars. Waiting: zero", collectedEarly(96) === 134400 && collectedLate(96) === 0, "race");
ssays("S04", "a thousand eighty dollars a month", TOP === 1080, "top");
ssays("S04", "A little past eighty, they're even", beAge > 80 && beAge < 80.75, "be");
ssays("S05", "about six in ten do", Math.round(surv("m", 80) * 10) === 6, "men");
ssays("S05", "a man lives to about eighty-two", Math.round(62 + life[62].me) === 82, "e62");
ssays("S06", "ahead by about a hundred ninety thousand", K10(collectedLate(396) - collectedEarly(396)) === 190, "95");
const sTerms = new Set(["S02", "S07"]);
for (const l of short.lines) if (numberWords.test(l.text) && !["S01", "S03", "S04", "S05", "S06"].includes(l.id) && !sTerms.has(l.id)) failures.push(`short ${l.id} speaks a number no claim checks`);

// ---- hook-first Short (2026-11-14)
const hsays = sayer(hook, "hook ");
hsays("H01", "Social Security at sixty-two and put every check into stocks", true, "Minh's way, months 0-95");
hsays("H01", "By eighty-six, it was all gone", R00.runout != null && ageOf(R00.runout) < 86 && ageOf(R00.runout) > 85.5, `pile empty at ${ageOf(R00.runout).toFixed(2)}`);
hsays("H03", "January two thousand", R00.m === "2000-01", R00.m);
hsays("H03", "Every fourteen hundred dollar check goes into stocks", EARLY === 1400, "early");
hsays("H03", "Then two thousand eight", R00.runout > 110 && sh[at.get("2000-01") + 110].m === "2009-03", "month 110 lands in March 2009, pile still paying");
hsays("H04", "December twenty twenty-three", sh[at.get("2000-01") + R00.runout].m === "2023-12", sh[at.get("2000-01") + R00.runout].m);
hsays("H05", "back to fourteen hundred a month", EARLY === 1400, "early check after runout");
hsays("H05", "Waiting until seventy pays twenty-four eighty, for life", LATE === 2480, "late");
hsays("H06", "Since eighteen seventy-one", windows[0].m === "1871-01", windows[0].m);
hsays("H06", "it lasted to a hundred a little under half the time", share(lasted) > 0.4 && share(lasted) < 0.5, `${lasted.length}/${windows.length}`);
hsays("H06", "About one in three, it ran out before ninety", near(share(before(90)), 1 / 3, 0.03), `${before(90).length}`);
const hMonth = Object.fromEntries(hook.lines.map((l) => [l.id, l.month]));
check(hMonth.H03 === 110 && hMonth.H04 === R00.runout, `hook replay months ${hMonth.H03}/${hMonth.H04} vs runout ${R00.runout}`);
const hTerms = new Set(["H07"]); // ages 62/70 as the two choices
for (const l of hook.lines) if (numberWords.test(l.text) && !["H01", "H03", "H04", "H05", "H06"].includes(l.id) && !hTerms.has(l.id)) failures.push(`hook ${l.id} speaks a number no claim checks`);

if (failures.length) {
  console.error(`validate-ep10-story: ${failures.length} FAIL of ${checks}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(`validate-ep10-story: ${checks}/${checks} PASS (break-even age ${beAge.toFixed(2)}, ${windows.length} starts, replays 1990-01 and 2000-01 to ${sh[last].m})`);
}
