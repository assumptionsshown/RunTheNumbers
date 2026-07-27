// Capture each slide of an episode as a 1920x1080 PNG using an installed
// Chromium browser in headless mode. No npm automation library: the browser
// binary already on the machine is enough.
//
//   node tools/capture-frames.mjs [--episode ep01] [--slides 10] [--port 5173]
//
// Requires the render server to be running: node tools/serve.mjs
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const episode = argOf("--episode", "ep01");
const slides = Number(argOf("--slides", "10"));
const port = argOf("--port", "5173");
// --page lets the same capture loop serve thumbnails, which live on their own
// page at their own size.
const page = argOf("--page", episode);
const [width, height] = argOf("--size", "1920,1080").split(",").map(Number);
const outName = argOf("--out", episode);
const root = join(import.meta.dirname, "..");
const outDir = join(root, "render", "frames", outName);

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) throw new Error(`no Chromium browser found; looked in:\n  ${CANDIDATES.join("\n  ")}`);
console.log(`using ${browser}`);

mkdirSync(outDir, { recursive: true });

const capture = (slide) =>
  new Promise((resolve, reject) => {
    const out = join(outDir, `slide-${String(slide).padStart(2, "0")}.png`);
    // A throwaway profile keeps this from colliding with the user's running browser.
    const profile = join(tmpdir(), `rtn-capture-${process.pid}-${slide}`);
    const url = `http://localhost:${port}/render/${page}.html?only=${slide}`;

    const child = spawn(browser, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      // The page fetches results.json, so give it virtual time to settle
      // before the frame is taken.
      "--virtual-time-budget=4000",
      `--user-data-dir=${profile}`,
      `--screenshot=${out}`,
      url,
    ], { stdio: "ignore" });

    child.on("error", reject);
    child.on("exit", (code) => {
      rmSync(profile, { recursive: true, force: true });
      if (code === 0 && existsSync(out)) {
        console.log(`  slide ${slide} -> ${out}`);
        resolve(out);
      } else {
        reject(new Error(`slide ${slide} failed (exit ${code})`));
      }
    });
  });

for (let i = 1; i <= slides; i++) await capture(i);
console.log(`\ncaptured ${slides} frames into ${outDir}`);
