// Minimal BIFF8 (.xls) worksheet reader.
//
// Only what is needed to recover a rectangular grid of values: shared strings,
// numbers, RK-compressed numbers, and cached formula results. Charts, styles,
// and formatting are ignored on purpose.

const REC = {
  FORMULA: 0x0006,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  BOUNDSHEET: 0x0085,
  MULRK: 0x00bd,
  SST: 0x00fc,
  LABELSST: 0x00fd,
  BLANK: 0x0201,
  NUMBER: 0x0203,
  LABEL: 0x0204,
  BOOLERR: 0x0205,
  STRING: 0x0207,
  RK: 0x027e,
  BOF: 0x0809,
};

const SUBSTREAM_WORKSHEET = 0x0010;

// RK values pack a number into 32 bits: bit 0 means "divide by 100", bit 1
// means the remaining 30 bits are a signed integer rather than the high 30
// bits of an IEEE 754 double.
function decodeRk(rk) {
  let value;
  if (rk & 0x02) {
    value = rk >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeInt32LE(rk & 0xfffffffc, 4);
    value = b.readDoubleLE(0);
  }
  return rk & 0x01 ? value / 100 : value;
}

// The shared string table can spill across CONTINUE records, and a string may
// be split mid-way. When that happens the continuation restarts with a fresh
// encoding flag byte, so the segments cannot simply be concatenated.
class SegmentReader {
  constructor(segments) {
    this.segs = segments;
    this.si = 0;
    this.off = 0;
  }

  _settle() {
    while (this.si < this.segs.length && this.off >= this.segs[this.si].length) {
      this.si++;
      this.off = 0;
    }
  }

  get done() {
    this._settle();
    return this.si >= this.segs.length;
  }

  u8() {
    this._settle();
    return this.segs[this.si][this.off++];
  }

  _num(size, read) {
    this._settle();
    const seg = this.segs[this.si];
    if (this.off + size <= seg.length) {
      const v = read(seg, this.off);
      this.off += size;
      return v;
    }
    // Spec says headers are never split across a CONTINUE, but stitch bytes
    // together rather than silently returning garbage if one ever is.
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = this.u8();
    return read(bytes, 0);
  }

  u16() {
    return this._num(2, (b, o) => b.readUInt16LE(o));
  }

  u32() {
    return this._num(4, (b, o) => b.readUInt32LE(o));
  }

  skip(n) {
    let left = n;
    while (left > 0 && !this.done) {
      const seg = this.segs[this.si];
      const take = Math.min(left, seg.length - this.off);
      this.off += take;
      left -= take;
      this._settle();
    }
  }

  string() {
    const cch = this.u16();
    const grbit = this.u8();
    let wide = (grbit & 0x01) !== 0;
    const rich = (grbit & 0x08) !== 0;
    const ext = (grbit & 0x04) !== 0;
    const cRun = rich ? this.u16() : 0;
    const cbExt = ext ? this.u32() : 0;

    let out = "";
    let left = cch;
    while (left > 0) {
      this._settle();
      if (this.done) break;
      const seg = this.segs[this.si];
      const charSize = wide ? 2 : 1;
      const take = Math.min(left, Math.floor((seg.length - this.off) / charSize));
      if (take > 0) {
        const end = this.off + take * charSize;
        out += wide
          ? seg.toString("utf16le", this.off, end)
          : seg.toString("latin1", this.off, end);
        this.off = end;
        left -= take;
      }
      if (left > 0) {
        // Cross into the next CONTINUE, which restarts with an encoding byte.
        this.si++;
        this.off = 0;
        if (this.done) break;
        wide = (this.segs[this.si][this.off++] & 0x01) !== 0;
      }
    }

    this.skip(cRun * 4);
    this.skip(cbExt);
    return out;
  }
}

function parseSst(segments) {
  const reader = new SegmentReader(segments);
  reader.u32(); // total occurrences, unused
  const unique = reader.u32();
  const strings = [];
  for (let i = 0; i < unique && !reader.done; i++) strings.push(reader.string());
  return strings;
}

export function readWorkbook(stream) {
  const records = [];
  let off = 0;
  while (off + 4 <= stream.length) {
    const type = stream.readUInt16LE(off);
    const size = stream.readUInt16LE(off + 2);
    const start = off + 4;
    if (start + size > stream.length) break;
    records.push({ type, data: stream.subarray(start, start + size), offset: off });
    off = start + size;
  }

  // Charts are substreams too, so worksheets cannot be named by ordinal.
  // BOUNDSHEET carries the absolute stream offset of its substream; match on that.
  const boundsheets = new Map();
  let sst = [];
  const sheets = [];
  let current = null;
  let lastFormulaCell = null;

  for (let i = 0; i < records.length; i++) {
    const { type, data, offset } = records[i];

    switch (type) {
      case REC.BOF: {
        const substream = data.length >= 4 ? data.readUInt16LE(2) : 0;
        if (substream === SUBSTREAM_WORKSHEET) {
          current = {
            name: boundsheets.get(offset) ?? `Sheet${sheets.length + 1}`,
            cells: new Map(),
            maxRow: -1,
            maxCol: -1,
          };
          sheets.push(current);
        }
        break;
      }

      case REC.EOF:
        current = null;
        break;

      case REC.BOUNDSHEET: {
        const substreamOffset = data.readUInt32LE(0);
        const cch = data[6];
        const wide = (data[7] & 0x01) !== 0;
        const name = wide
          ? data.toString("utf16le", 8, 8 + cch * 2)
          : data.toString("latin1", 8, 8 + cch);
        boundsheets.set(substreamOffset, name);
        break;
      }

      case REC.SST: {
        const segments = [data];
        let j = i + 1;
        while (j < records.length && records[j].type === REC.CONTINUE) {
          segments.push(records[j].data);
          j++;
        }
        sst = parseSst(segments);
        i = j - 1;
        break;
      }

      case REC.NUMBER:
        setCell(current, data.readUInt16LE(0), data.readUInt16LE(2), data.readDoubleLE(6));
        break;

      case REC.RK:
        setCell(current, data.readUInt16LE(0), data.readUInt16LE(2), decodeRk(data.readInt32LE(6)));
        break;

      case REC.MULRK: {
        const row = data.readUInt16LE(0);
        const first = data.readUInt16LE(2);
        const count = (data.length - 6) / 6;
        for (let k = 0; k < count; k++) {
          const rk = data.readInt32LE(4 + k * 6 + 2);
          setCell(current, row, first + k, decodeRk(rk));
        }
        break;
      }

      case REC.LABELSST: {
        const idx = data.readUInt32LE(6);
        setCell(current, data.readUInt16LE(0), data.readUInt16LE(2), sst[idx] ?? "");
        break;
      }

      case REC.LABEL: {
        const cch = data.readUInt16LE(6);
        const wide = (data[8] & 0x01) !== 0;
        const text = wide
          ? data.toString("utf16le", 9, 9 + cch * 2)
          : data.toString("latin1", 9, 9 + cch);
        setCell(current, data.readUInt16LE(0), data.readUInt16LE(2), text);
        break;
      }

      case REC.FORMULA: {
        const row = data.readUInt16LE(0);
        const col = data.readUInt16LE(2);
        // A result of 0xFFFF in the top two bytes flags a non-numeric result.
        if (data[12] === 0xff && data[13] === 0xff) {
          const kind = data[6];
          if (kind === 0) {
            lastFormulaCell = { row, col }; // value arrives in the next STRING
          } else if (kind === 1) {
            setCell(current, row, col, data[8] !== 0);
          }
          // kind 2 (error) and 3 (blank) are left empty on purpose.
        } else {
          setCell(current, row, col, data.readDoubleLE(6));
        }
        break;
      }

      case REC.STRING: {
        if (lastFormulaCell) {
          const cch = data.readUInt16LE(0);
          const wide = (data[2] & 0x01) !== 0;
          const text = wide
            ? data.toString("utf16le", 3, 3 + cch * 2)
            : data.toString("latin1", 3, 3 + cch);
          setCell(current, lastFormulaCell.row, lastFormulaCell.col, text);
          lastFormulaCell = null;
        }
        break;
      }

      default:
        break;
    }
  }

  return sheets;
}

function setCell(sheet, row, col, value) {
  if (!sheet) return;
  let r = sheet.cells.get(row);
  if (!r) {
    r = new Map();
    sheet.cells.set(row, r);
  }
  r.set(col, value);
  if (row > sheet.maxRow) sheet.maxRow = row;
  if (col > sheet.maxCol) sheet.maxCol = col;
}

export function sheetToRows(sheet) {
  const rows = [];
  for (let r = 0; r <= sheet.maxRow; r++) {
    const src = sheet.cells.get(r);
    const row = [];
    for (let c = 0; c <= sheet.maxCol; c++) {
      row.push(src?.get(c) ?? null);
    }
    rows.push(row);
  }
  return rows;
}
