// Split an episode script into one voice-over text file per slide.
//
//   node tools/extract-vo.mjs [--episode ep01]
//
// The script is the single source of truth for what is said. Slide timing is
// derived later from the length of each slide's audio, so nothing is timed by
// hand and re-recording a line cannot desynchronise the video.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const episode = argOf("--episode", "ep01");
const root = join(import.meta.dirname, "..");
const episodeDir = join(root, "episodes");

// Episode folders are named ep01-<slug>, so find the one with this prefix.
const { readdirSync } = await import("node:fs");
const folder = readdirSync(episodeDir).find((d) => d.startsWith(`${episode}-`) || d === episode);
if (!folder) throw new Error(`no episode folder for "${episode}" in ${episodeDir}`);

const scriptPath = join(episodeDir, folder, "script.md");
const text = readFileSync(scriptPath, "utf8");

// Sections look like:  ### [SLIDE 3 - histogram] 1:05
const HEADER = /^###\s*\[SLIDE\s+(\d+)[^\]]*\]/i;

const lines = text.split(/\r?\n/);
const slides = new Map();
let current = null;

for (const line of lines) {
  const m = line.match(HEADER);
  if (m) {
    current = Number(m[1]);
    slides.set(current, []);
    continue;
  }
  if (current === null) continue;

  // A horizontal rule or a new top-level section ends the voice over.
  if (/^---\s*$/.test(line) || /^##\s/.test(line)) {
    current = null;
    continue;
  }
  slides.get(current).push(line);
}

if (slides.size === 0) throw new Error(`no "### [SLIDE n]" sections found in ${scriptPath}`);

const outDir = join(episodeDir, folder, "vo");
mkdirSync(outDir, { recursive: true });

const manifest = [];
for (const [n, body] of [...slides].sort((a, b) => a[0] - b[0])) {
  const spoken = body
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")   // strip emphasis markers
    .replace(/[*_`]/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

  const file = join(outDir, `slide-${String(n).padStart(2, "0")}.txt`);
  writeFileSync(file, spoken + "\n", "utf8");

  const words = spoken.split(/\s+/).filter(Boolean).length;
  manifest.push({ slide: n, words, estimatedSeconds: Math.round((words / 150) * 60) });
  console.log(`slide ${String(n).padStart(2, "0")}  ${String(words).padStart(4)} words  ~${manifest.at(-1).estimatedSeconds}s`);
}

const totalWords = manifest.reduce((s, m) => s + m.words, 0);
const totalSeconds = manifest.reduce((s, m) => s + m.estimatedSeconds, 0);
console.log(`\n${manifest.length} slides, ${totalWords} words, ~${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s at 150 wpm`);

writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
