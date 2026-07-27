// Generate YouTube chapter timestamps from the assembled audio.
//
//   node tools/build-chapters.mjs [--episode ep01] [--gap 0.7]
//
// Chapter titles come from the slide headings in script.md; the times come from
// the real clip lengths. Hand-written timestamps drift the moment a line is
// re-recorded, and a description whose chapters do not match the video is the
// cheapest possible way to look careless.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const episode = argOf("--episode", "ep01");
const gap = Number(argOf("--gap", "0.7"));
const fps = Number(argOf("--fps", "30"));

const root = join(import.meta.dirname, "..");
const folder = readdirSync(join(root, "episodes"))
  .find((d) => d.startsWith(`${episode}-`) || d === episode);
if (!folder) throw new Error(`no episode folder for "${episode}"`);

const episodeDir = join(root, "episodes", folder);
const audioDir = join(episodeDir, "audio");

// Slide headings look like:  ### [SLIDE 3 - histogram | The answer]
// The part after the pipe is the viewer-facing chapter title. Slides without one
// get no chapter, because a marker every thirty seconds is noise rather than
// navigation.
const headings = new Map();
for (const line of readFileSync(join(episodeDir, "script.md"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^###\s*\[SLIDE\s+(\d+)\s*-\s*([^\]|]+)(?:\|([^\]]+))?\]/i);
  if (m && m[3]) headings.set(Number(m[1]), m[3].trim());
}
if (headings.size < 3) {
  throw new Error(
    `only ${headings.size} chapter titles found. YouTube needs at least three. ` +
    `Add "| Chapter title" to the slide headings in script.md.`,
  );
}

const duration = (file) =>
  Number(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", file,
  ]).toString().trim());

const stamp = (seconds) => {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const clips = readdirSync(audioDir).filter((f) => /^slide-\d+\.wav$/.test(f)).sort();

let t = 0;
const chapters = [];
for (const clip of clips) {
  const n = Number(clip.match(/(\d+)/)[1]);
  if (headings.has(n)) chapters.push({ slide: n, at: t, title: headings.get(n) });
  // Must match build-video.mjs exactly, including the frame snapping.
  t += Math.round((duration(join(audioDir, clip)) + gap) * fps) / fps;
}

// YouTube requires the first chapter to start at 0:00 and at least three chapters.
const lines = chapters.map((c) => `${stamp(c.at)} ${c.title}`);
const out = lines.join("\n");

writeFileSync(join(episodeDir, "chapters.txt"), out + "\n", "utf8");

console.log(out);
console.log(`\ntotal ${stamp(t)}  (${chapters.length} chapters)`);
console.log(`wrote ${join(episodeDir, "chapters.txt")}`);

if (chapters[0].at !== 0) throw new Error("first chapter must start at 0:00");
