// Convert a legacy .xls workbook to one CSV per sheet.
//
//   node tools/xls-to-csv.mjs <input.xls> <outputDir> [--list]
//
// --list prints sheet names and dimensions without writing anything.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readCompoundFile } from "./lib/cfb.mjs";
import { readWorkbook, sheetToRows } from "./lib/biff.mjs";

const [input, outDir] = process.argv.slice(2);
const listOnly = process.argv.includes("--list");

if (!input) {
  console.error("usage: node xls-to-csv.mjs <input.xls> <outputDir> [--list]");
  process.exit(1);
}

const { streams } = readCompoundFile(readFileSync(input));
const workbookStream = streams.get("Workbook") ?? streams.get("Book");
if (!workbookStream) {
  throw new Error(
    `no Workbook stream found; streams present: ${[...streams.keys()].join(", ")}`,
  );
}

const sheets = readWorkbook(workbookStream);

for (const sheet of sheets) {
  console.log(
    `${sheet.name}: ${sheet.maxRow + 1} rows x ${sheet.maxCol + 1} cols`,
  );
}

if (listOnly) process.exit(0);
if (!outDir) {
  console.error("outputDir is required unless --list is passed");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const escape = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

for (const sheet of sheets) {
  const rows = sheetToRows(sheet);
  const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
  const safe = sheet.name.replace(/[^A-Za-z0-9._-]+/g, "_");
  const path = join(outDir, `${safe}.csv`);
  writeFileSync(path, csv, "utf8");
  console.log(`wrote ${path} (${rows.length} rows)`);
}
