// Minimal OLE2 / Compound File Binary (CFB) reader.
//
// Legacy .xls files are CFB containers holding a stream named "Workbook".
// Written from the MS-CFB spec rather than pulled from npm so the public repo
// stays dependency-free and auditable: viewers who want to re-run our numbers
// should not have to trust a supply chain to do it.

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function readCompoundFile(buf) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error("not a CFB file (bad signature)");
  }

  const sectorShift = buf.readUInt16LE(0x1e);
  const miniSectorShift = buf.readUInt16LE(0x20);
  const numFatSectors = buf.readUInt32LE(0x2c);
  const firstDirSector = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const firstMiniFatSector = buf.readUInt32LE(0x3c);
  const numMiniFatSectors = buf.readUInt32LE(0x40);
  const firstDifatSector = buf.readUInt32LE(0x44);
  const numDifatSectors = buf.readUInt32LE(0x48);

  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;

  // Sector N lives immediately after the header sector.
  const sectorOffset = (sec) => (sec + 1) * sectorSize;

  const readSector = (sec) => {
    const start = sectorOffset(sec);
    if (start + sectorSize > buf.length) {
      throw new Error(`sector ${sec} out of bounds`);
    }
    return buf.subarray(start, start + sectorSize);
  };

  // --- DIFAT: the list of sectors that make up the FAT ---------------------
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    const sec = buf.readUInt32LE(0x4c + i * 4);
    if (sec === FREESECT || sec === ENDOFCHAIN) break;
    fatSectors.push(sec);
  }

  let difatSec = firstDifatSector;
  const entriesPerDifat = sectorSize / 4 - 1;
  for (let n = 0; n < numDifatSectors && difatSec !== ENDOFCHAIN && difatSec !== FREESECT; n++) {
    const sect = readSector(difatSec);
    for (let i = 0; i < entriesPerDifat && fatSectors.length < numFatSectors; i++) {
      const sec = sect.readUInt32LE(i * 4);
      if (sec === FREESECT || sec === ENDOFCHAIN) break;
      fatSectors.push(sec);
    }
    difatSec = sect.readUInt32LE(entriesPerDifat * 4);
  }

  // --- FAT -----------------------------------------------------------------
  const fat = [];
  for (const sec of fatSectors) {
    const sect = readSector(sec);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sect.readUInt32LE(i * 4));
  }

  const followChain = (start, table) => {
    const chain = [];
    let sec = start;
    const guard = table.length + 16;
    while (sec !== ENDOFCHAIN && sec !== FREESECT && sec !== DIFSECT && sec !== FATSECT) {
      chain.push(sec);
      if (chain.length > guard) throw new Error("sector chain does not terminate");
      sec = table[sec];
      if (sec === undefined) break;
    }
    return chain;
  };

  const readChain = (start, size, table, readOne, unitSize) => {
    const parts = followChain(start, table).map(readOne);
    const all = Buffer.concat(parts);
    return size != null && size <= all.length ? all.subarray(0, size) : all;
  };

  // --- Mini FAT ------------------------------------------------------------
  const miniFat = [];
  if (numMiniFatSectors > 0) {
    for (const sec of followChain(firstMiniFatSector, fat)) {
      const sect = readSector(sec);
      for (let i = 0; i < sectorSize / 4; i++) miniFat.push(sect.readUInt32LE(i * 4));
    }
  }

  // --- Directory entries ---------------------------------------------------
  const dirBytes = readChain(firstDirSector, null, fat, readSector, sectorSize);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const nameLen = dirBytes.readUInt16LE(off + 0x40);
    const type = dirBytes[off + 0x42];
    if (type === 0) continue; // unused slot
    const name =
      nameLen > 2 ? dirBytes.toString("utf16le", off, off + nameLen - 2) : "";
    entries.push({
      name,
      type, // 1 storage, 2 stream, 5 root
      startSector: dirBytes.readUInt32LE(off + 0x74),
      size: Number(dirBytes.readBigUInt64LE(off + 0x78)),
    });
  }

  const root = entries.find((e) => e.type === 5);
  if (!root) throw new Error("CFB has no root directory entry");

  // The mini stream itself is stored as a normal stream hanging off the root.
  const miniStream = readChain(root.startSector, root.size, fat, readSector, sectorSize);
  const readMiniSector = (sec) => {
    const start = sec * miniSectorSize;
    return miniStream.subarray(start, start + miniSectorSize);
  };

  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue;
    const bytes =
      e.size < miniCutoff
        ? readChain(e.startSector, e.size, miniFat, readMiniSector, miniSectorSize)
        : readChain(e.startSector, e.size, fat, readSector, sectorSize);
    streams.set(e.name, bytes);
  }

  return { streams, entries };
}
