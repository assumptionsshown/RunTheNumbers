// Diagnostics for a legacy .xls: CFB streams, BOUNDSHEET entries (name, type,
// stream offset), and the sequence of BOF substreams actually encountered.
import { readFileSync } from "node:fs";
import { readCompoundFile } from "./lib/cfb.mjs";

const input = process.argv[2];
if (!input) {
  console.error("usage: node diag-biff.mjs <input.xls>");
  process.exit(1);
}

const { streams } = readCompoundFile(readFileSync(input));

console.log("--- CFB streams ---");
for (const [name, bytes] of streams) {
  console.log(`  ${JSON.stringify(name)}  ${bytes.length} bytes`);
}

const wb = streams.get("Workbook") ?? streams.get("Book");
if (!wb) process.exit(1);

const SUBSTREAM = { 0x0005: "globals", 0x0006: "vb", 0x0010: "worksheet", 0x0020: "chart", 0x0040: "macro" };
const SHEET_TYPE = { 0x00: "worksheet", 0x01: "macro", 0x02: "chart", 0x06: "vb" };

const boundsheets = [];
const bofs = [];
let recCount = 0;
let off = 0;

while (off + 4 <= wb.length) {
  const type = wb.readUInt16LE(off);
  const size = wb.readUInt16LE(off + 2);
  const start = off + 4;
  if (start + size > wb.length) {
    console.log(`\n!! truncated record at ${off}: type=0x${type.toString(16)} size=${size}`);
    break;
  }
  const data = wb.subarray(start, start + size);
  recCount++;

  if (type === 0x0085) {
    const pos = data.readUInt32LE(0);
    const dt = data[5];
    const cch = data[6];
    const wide = (data[7] & 0x01) !== 0;
    const name = wide
      ? data.toString("utf16le", 8, 8 + cch * 2)
      : data.toString("latin1", 8, 8 + cch);
    boundsheets.push({ name, dt, pos });
  }

  if (type === 0x0809) {
    bofs.push({ off, substream: size >= 4 ? data.readUInt16LE(2) : -1 });
  }

  off = start + size;
}

console.log(`\n--- workbook stream: ${wb.length} bytes, ${recCount} records, ended at ${off} ---`);

console.log("\n--- BOUNDSHEET ---");
for (const b of boundsheets) {
  console.log(`  ${JSON.stringify(b.name).padEnd(28)} type=${SHEET_TYPE[b.dt] ?? b.dt}  offset=${b.pos}`);
}

console.log("\n--- BOF substreams ---");
for (const b of bofs) {
  console.log(`  offset=${String(b.off).padEnd(9)} ${SUBSTREAM[b.substream] ?? "0x" + b.substream.toString(16)}`);
}
