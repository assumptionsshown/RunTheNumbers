// Detect the real container format of a downloaded spreadsheet.
// Yale serves ie_data with an "application/vnd.ms-excel" content type regardless
// of whether the file is a legacy OLE/BIFF .xls or a modern zip-based .xlsx,
// so the extension and content type cannot be trusted.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node inspect-format.mjs <file>");
  process.exit(1);
}

const head = readFileSync(path).subarray(0, 8);
const hex = [...head].map((b) => b.toString(16).padStart(2, "0")).join(" ");

const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP = [0x50, 0x4b];

let format = "unknown";
if (OLE.every((b, i) => head[i] === b)) format = "xls (legacy OLE/BIFF)";
else if (ZIP.every((b, i) => head[i] === b)) format = "xlsx (zip/OOXML)";

console.log(`magic: ${hex}`);
console.log(`format: ${format}`);
