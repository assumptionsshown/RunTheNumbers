// Capture an animation as a numbered PNG sequence.
//
//   node tools/capture-animation.mjs --anim histogram [--episode ep01] [--fps 30]
//
// Requires the render server: node tools/serve.mjs
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
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
const [width, height] = argOf("--size", "1920,1080").split(",").map(Number);

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

const browser = await Browser.launch({ url, width, height });

try {
  // Null-safe: during navigation the document can be mid-swap, and a poll that
  // lands in that window would otherwise throw instead of retrying.
  await browser.waitFor("document.documentElement?.dataset?.ready === '1'");
  const frames = await browser.evaluate("window.FRAME_COUNT");
  if (!frames) throw new Error("page did not expose FRAME_COUNT");

  console.log(`${frames} frames at ${fps} fps = ${(frames / fps).toFixed(1)}s`);
  const started = Date.now();

  for (let i = 0; i < frames; i++) {
    await browser.evaluate(`window.renderFrame(${i})`);
    const png = await browser.screenshot();
    writeFileSync(join(outDir, `frame-${String(i).padStart(5, "0")}.png`), png);

    if (i % 30 === 0 || i === frames - 1) {
      const rate = (i + 1) / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  ${i + 1}/${frames}  ${rate.toFixed(1)} fps captured   `);
    }
  }

  const elapsed = (Date.now() - started) / 1000;
  console.log(`\ndone in ${elapsed.toFixed(1)}s -> ${outDir}`);
} finally {
  await browser.close();
}
