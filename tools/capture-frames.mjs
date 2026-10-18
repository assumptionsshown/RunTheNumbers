// Capture each slide of an episode as a 1920x1080 PNG using an installed
// Chromium browser in headless mode. No npm automation library: the browser
// binary already on the machine is enough.
//
//   node tools/capture-frames.mjs [--episode ep01] [--slides 10] [--slide 7] [--port 5173]
//
// Starts a temporary render server when one is not already running.
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
const onlySlide = args.includes("--slide") ? Number(argOf("--slide", "1")) : null;
const port = argOf("--port", "5173");
// --page lets the same capture loop serve thumbnails, which live on their own
// page at their own size.
const page = argOf("--page", episode);
const [width, height] = argOf("--size", "1920,1080").split(",").map(Number);
const outName = argOf("--out", episode);
const root = join(import.meta.dirname, "..");
const outDir = join(root, "render", "frames", outName);
const serverUrl = `http://localhost:${port}`;

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

// Own the local server when one is not already running. This keeps capture
// self-contained on hosts that forbid detached background processes, and the
// child is always stopped when capture finishes.
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const serverReady = async () => {
  try {
    const response = await fetch(`${serverUrl}/render/${page}.html`);
    return response.ok;
  } catch {
    return false;
  }
};

let server = null;
if (!(await serverReady())) {
  server = spawn(process.execPath, [join(root, "tools", "serve.mjs"), port], {
    cwd: root,
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 30 && !(await serverReady()); attempt += 1) {
    await wait(200);
  }
  if (!(await serverReady())) {
    server.kill();
    throw new Error(`render server did not become ready at ${serverUrl}`);
  }
  console.log(`started temporary render server on ${serverUrl}`);
}

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

try {
  const selectedSlides = onlySlide == null
    ? Array.from({ length: slides }, (_, index) => index + 1)
    : [onlySlide];
  for (const slide of selectedSlides) await capture(slide);
  console.log(`\ncaptured ${selectedSlides.length} frame(s) into ${outDir}`);
} finally {
  if (server) {
    server.kill();
    console.log("stopped temporary render server");
  }
}
