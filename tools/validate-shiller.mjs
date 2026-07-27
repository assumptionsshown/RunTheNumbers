// Independent validation of a pinned Shiller snapshot.
//
//   node tools/validate-shiller.mjs <snapshotDir>
//
// The BIFF parser in this repo is hand-written, so its output is cross-checked
// against a source that shares none of its code: FRED's CPI series, plus
// arithmetic sanity checks on the return series itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node validate-shiller.mjs <snapshotDir>");
  process.exit(1);
}

const text = readFileSync(join(dir, "shiller-monthly.csv"), "utf8").trim();
const [header, ...lines] = text.split("\n");
const fields = header.split(",");
const rows = lines.map((line) => {
  const parts = line.split(",");
  return Object.fromEntries(
    fields.map((f, i) => [f, parts[i] === "" ? null : f === "date" ? parts[i] : Number(parts[i])]),
  );
});

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- 1. Shape -------------------------------------------------------------
check("monthly series is contiguous", (() => {
  for (let i = 1; i < rows.length; i++) {
    const [py, pm] = rows[i - 1].date.split("-").map(Number);
    const [cy, cm] = rows[i].date.split("-").map(Number);
    const expected = pm === 12 ? [py + 1, 1] : [py, pm + 1];
    if (cy !== expected[0] || cm !== expected[1]) return false;
  }
  return true;
})(), `${rows.length} months ${rows[0].date}..${rows.at(-1).date}`);

check(
  "total return index is strictly positive and never missing",
  rows.every((r) => r.realTotalReturnPrice > 0),
);

// --- 2. Long-run real total return ----------------------------------------
// US equities have returned roughly 6.5-7% real over this span. A parser bug in
// RK decoding or column mapping would almost certainly land outside that.
const first = rows[0].realTotalReturnPrice;
const last = rows.at(-1).realTotalReturnPrice;
const years = (rows.length - 1) / 12;
const cagr = (last / first) ** (1 / years) - 1;
check(
  "long-run real total return in 6-8%/yr",
  cagr > 0.06 && cagr < 0.08,
  `${(cagr * 100).toFixed(3)}%/yr over ${years.toFixed(1)}y`,
);

// --- 3. Known landmarks ---------------------------------------------------
// The 1929-1932 real total return drawdown is one of the most documented
// numbers in finance: roughly -79% to -81%.
const window = rows.filter((r) => r.date >= "1929-01" && r.date <= "1933-12");
const peak = Math.max(...window.map((r) => r.realTotalReturnPrice));
const trough = Math.min(...window.map((r) => r.realTotalReturnPrice));
const dd = trough / peak - 1;
check(
  "1929-33 real total return drawdown near -80%",
  dd < -0.75 && dd > -0.85,
  `${(dd * 100).toFixed(1)}%`,
);

// --- 4. CPI cross-check against FRED --------------------------------------
// Shiller uses CPI-U, not seasonally adjusted = FRED series CPIAUCNS.
const res = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCNS");
if (!res.ok) {
  console.log(`SKIP  CPI cross-check (FRED returned ${res.status})`);
} else {
  const fred = new Map();
  for (const line of (await res.text()).trim().split("\n").slice(1)) {
    const [date, value] = line.split(",");
    if (value && value !== ".") fred.set(date.slice(0, 7), Number(value));
  }

  let compared = 0;
  let worst = { date: null, diff: 0 };
  for (const r of rows) {
    const f = fred.get(r.date);
    if (f === undefined || r.cpi === null) continue;
    compared++;
    const diff = Math.abs(r.cpi - f) / f;
    if (diff > worst.diff) worst = { date: r.date, diff };
  }
  check(
    "CPI matches FRED CPIAUCNS",
    compared > 500 && worst.diff < 0.01,
    `${compared} months compared, worst gap ${(worst.diff * 100).toFixed(3)}% at ${worst.date}`,
  );
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
// Set exitCode rather than calling process.exit(): an abrupt exit while fetch's
// keep-alive socket is still open trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
