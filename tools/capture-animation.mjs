// Capture an animation as a numbered PNG sequence.
//
//   node tools/capture-animation.mjs --anim histogram [--episode ep01] [--fps 30]
//                                    [--workers 4]
//
// Requires the render server: node tools/serve.mjs
//
// PARALLEL BY DEFAULT, and it is safe for a specific reason: every renderer in
// this repo exposes `window.renderFrame(i)` as a PURE FUNCTION OF i. Frame 900
// draws the same pixels whether or not frames 0-899 were drawn first — the
// camera track is precomputed, event frames are precomputed, and the shimmer
// phase is derived from i. So the range can be cut into blocks and handed to
// several browsers at once, and the result is byte-identical to a serial run.
//
// If a future renderer ever accumulates state between frames that contract is
// broken and this tool will silently produce wrong frames. The contract is the
// thing to protect, not this tool.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import { Browser } from "./lib/cdp.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const anim = argOf("--anim", "histogram");
const episode = argOf("--episode", "ep01");
const fps = Number(argOf("--fps", "30"));
const port = argOf("--port", "5173");
// Parallel captures must not share a CDP port, or they race the same page and
// interleave each other's frames (hit once on the trailer rebuild). Workers take
// consecutive ports from here.
const cdpPort = Number(argOf("--cdp-port", "9333"));
const [width, height] = argOf("--size", "1920,1080").split(",").map(Number);

// Four is a deliberate default rather than "as many cores as exist". Each worker
// is a full headless Chrome holding a 1920x1080 surface, and past roughly four
// the machine spends its time swapping between them instead of encoding frames.
const workers = Math.max(1, Number(argOf("--workers", String(Math.min(4, Math.max(1, availableParallelism() - 2))))));

// Episode animations follow the anim-<episode>.html convention; shorts live on
// their own shared page, so the page name can be overridden.
const page = argOf("--page", `anim-${episode}`);
const outName = argOf("--out", `anim-${anim}`);

const root = join(import.meta.dirname, "..");
const outDir = join(root, "render", "frames", episode, outName);

// Stale frames from a previous, longer run would be picked up by ffmpeg.
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Match the animation to the length of the narration it plays under.
const seconds = argOf("--seconds", "");
const url = `http://localhost:${port}/render/${page}.html?anim=${anim}&fps=${fps}` +
  (seconds ? `&seconds=${seconds}` : "");
console.log(`capturing ${anim} from ${url}`);

// One browser is opened first, on its own, to read FRAME_COUNT and to surface a
// page error as a page error rather than as four simultaneous timeouts.
const lead = await Browser.launch({ url, width, height, port: cdpPort });
let frames;
try {
  await lead.waitFor("document.documentElement?.dataset?.ready === '1'");
  frames = await lead.evaluate("window.FRAME_COUNT");
  if (!frames) throw new Error("page did not expose FRAME_COUNT");
} catch (err) {
  await lead.close();
  throw err;
}

const blocks = [];
{
  const per = Math.ceil(frames / workers);
  for (let w = 0; w < workers; w += 1) {
    const from = w * per;
    if (from >= frames) break;
    blocks.push({ from, to: Math.min(frames, from + per) });
  }
}

console.log(`${frames} frames at ${fps} fps = ${(frames / fps).toFixed(1)}s`);
console.log(`${blocks.length} worker${blocks.length === 1 ? "" : "s"}: `
  + blocks.map((b) => `${b.from}..${b.to - 1}`).join("  "));

const started = Date.now();
let done = 0;
const report = () => {
  const rate = done / ((Date.now() - started) / 1000);
  const left = rate > 0 ? (frames - done) / rate : 0;
  process.stdout.write(`\r  ${done}/${frames}  ${rate.toFixed(1)} fps  ~${left.toFixed(0)}s left   `);
};

async function runBlock(block, index, browser) {
  const b = browser ?? await Browser.launch({
    url, width, height, port: cdpPort + index,
  });
  try {
    if (!browser) await b.waitFor("document.documentElement?.dataset?.ready === '1'");
    for (let i = block.from; i < block.to; i += 1) {
      await b.evaluate(`window.renderFrame(${i})`);
      const png = await b.screenshot();
      writeFileSync(join(outDir, `frame-${String(i).padStart(5, "0")}.png`), png);
      done += 1;
      if (done % 25 === 0) report();
    }
  } finally {
    await b.close();
  }
}

try {
  // The lead browser is already open and ready; it takes the first block rather
  // than being thrown away and relaunched.
  await Promise.all(blocks.map((block, i) => runBlock(block, i, i === 0 ? lead : null)));
} catch (err) {
  await lead.close().catch(() => {});
  throw err;
}

report();
const elapsed = (Date.now() - started) / 1000;
console.log(`\ndone in ${elapsed.toFixed(1)}s (${(frames / elapsed).toFixed(1)} fps) -> ${outDir}`);
