// Download Shiller's monthly dataset, convert it, and pin it as a dated snapshot.
//
//   node tools/build-shiller-snapshot.mjs [--date YYYY-MM-DD] [--offline <xls>]
//
// Everything downstream reads the pinned snapshot, never the network. Re-running
// a past snapshot must reproduce identical numbers, which is the whole basis for
// telling viewers to go check the result themselves.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readCompoundFile } from "./lib/cfb.mjs";
import { readWorkbook, sheetToRows } from "./lib/biff.mjs";

// econ.yale.edu/~shiller/data/ie_data.xls is a STALE MIRROR (frozen at 2023-09
// as of this writing). shillerdata.com is the live one. Do not "simplify" this
// back to the Yale URL.
const SOURCE_URL =
  "https://img1.wsimg.com/blobby/go/e5e77e0b-59d1-44d9-ab25-4763ac982e53/downloads/165d8a6e-26bf-44ec-a26c-a35f7f993480/ie_data.xls";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const stamp = argOf("--date") ?? new Date().toISOString().slice(0, 10);
const offline = argOf("--offline");
const root = join(import.meta.dirname, "..");
const outDir = join(root, "data", "snapshots", `shiller-${stamp}`);
mkdirSync(outDir, { recursive: true });

const rawPath = join(outDir, "ie_data.xls");

if (offline) {
  copyFileSync(offline, rawPath);
  console.log(`using local file ${offline}`);
} else {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(rawPath, bytes);
  console.log(`downloaded ${bytes.length} bytes`);
}

const raw = readFileSync(rawPath);
const sha256 = createHash("sha256").update(raw).digest("hex");

const { streams } = readCompoundFile(raw);
const sheets = readWorkbook(streams.get("Workbook") ?? streams.get("Book"));
const data = sheets.find((s) => s.name.trim() === "Data");
if (!data) throw new Error(`no "Data" sheet; found: ${sheets.map((s) => s.name).join(", ")}`);

const rows = sheetToRows(data);

// Column layout of the Data sheet. Header block is 8 rows.
const COL = {
  date: 0,
  price: 1,
  dividend: 2,
  earnings: 3,
  cpi: 4,
  dateFraction: 5,
  gs10: 6,
  realPrice: 7,
  realDividend: 8,
  realTotalReturnPrice: 9,
  realEarnings: 10,
  cape: 12,
};

const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || t === "NA") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const series = [];
let skippedTail = 0;

for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  const dateVal = num(row[COL.date]);
  const frac = num(row[COL.dateFraction]);
  if (dateVal === null || frac === null) continue; // header rows and the footnote row

  const year = Math.floor(frac);
  // Date Fraction sits at the middle of the month: Jan 1871 -> 1871.041666.
  const month = Math.round((frac - year) * 12 + 0.5);
  if (month < 1 || month > 12) throw new Error(`bad month from fraction ${frac} at row ${i}`);

  // The "Date" column is a float, so 2025.10 (October) is indistinguishable from
  // 2025.01 (January) once parsed. Cross-check the derived month against the
  // strictly monthly sequence instead of trusting either one alone.
  const expected = { year: 1871 + Math.floor(series.length / 12), month: (series.length % 12) + 1 };
  if (year !== expected.year || month !== expected.month) {
    throw new Error(
      `month sequence broke at row ${i}: derived ${year}-${month}, expected ${expected.year}-${expected.month}`,
    );
  }

  const realTR = num(row[COL.realTotalReturnPrice]);
  if (realTR === null) {
    skippedTail++;
    continue;
  }

  series.push({
    date: `${year}-${String(month).padStart(2, "0")}`,
    price: num(row[COL.price]),
    dividend: num(row[COL.dividend]),
    earnings: num(row[COL.earnings]),
    cpi: num(row[COL.cpi]),
    gs10: num(row[COL.gs10]),
    realPrice: num(row[COL.realPrice]),
    realDividend: num(row[COL.realDividend]),
    realTotalReturnPrice: realTR,
    realEarnings: num(row[COL.realEarnings]),
    cape: num(row[COL.cape]),
  });
}

// The final row of the sheet is always partial: the price is an intra-month
// close and recent CPI values are Shiller's estimates. Drop it so no episode
// ever rests on a month that will later be revised.
const dropped = series.pop();

const fields = Object.keys(series[0]);
const csv = [
  fields.join(","),
  ...series.map((r) => fields.map((f) => (r[f] === null ? "" : r[f])).join(",")),
].join("\n");

writeFileSync(join(outDir, "shiller-monthly.csv"), csv, "utf8");

const manifest = {
  source: offline ? `local:${offline}` : SOURCE_URL,
  note:
    "econ.yale.edu/~shiller/data/ie_data.xls is a stale mirror (frozen at 2023-09). Use shillerdata.com.",
  fetchedAt: stamp,
  sha256,
  rawBytes: raw.length,
  months: series.length,
  firstMonth: series[0].date,
  lastMonth: series[series.length - 1].date,
  droppedPartialMonth: dropped?.date ?? null,
  rowsWithoutTotalReturn: skippedTail,
  columnsUsed: COL,
};

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log(JSON.stringify(manifest, null, 2));
