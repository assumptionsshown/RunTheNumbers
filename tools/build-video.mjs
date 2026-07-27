// Assemble an episode: one still frame per slide, held for exactly as long as
// that slide's voice over runs, plus a short breath between slides.
//
//   node tools/build-video.mjs [--episode ep01] [--gap 0.7] [--fps 30]
//
// Nothing is timed by hand. Re-record a line, re-run this, and the video stays
// in sync by construction.
//
// Each slide is encoded as its own segment before the segments are joined. The
// obvious shortcut, feeding ffmpeg's concat demuxer a list of PNGs and a list of
// WAVs, silently produces the wrong length: that demuxer assumes every input
// shares identical stream parameters and quietly mistimes the result when they
// do not (for example TTS output at 22.05 kHz mixed with silence at 44.1 kHz).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const episode = argOf("--episode", "ep01");
const gap = Number(argOf("--gap", "0.7"));
const fps = Number(argOf("--fps", "30"));

// Every segment is normalised to these so the final join is a stream copy.
const SAMPLE_RATE = 48000;
const CHANNELS = 1;

const root = join(import.meta.dirname, "..");
const fwd = (p) => p.replaceAll("\\", "/");

const folder = readdirSync(join(root, "episodes"))
  .find((d) => d.startsWith(`${episode}-`) || d === episode);
if (!folder) throw new Error(`no episode folder for "${episode}"`);

const episodeDir = join(root, "episodes", folder);
const audioDir = join(episodeDir, "audio");
const frameDir = join(root, "render", "frames", episode);
const buildDir = join(episodeDir, "build");
const segDir = join(buildDir, "segments");
mkdirSync(segDir, { recursive: true });

const clips = readdirSync(audioDir).filter((f) => /^slide-\d+\.wav$/.test(f)).sort();
if (clips.length === 0) throw new Error(`no slide audio in ${audioDir}`);

const duration = (file) =>
  Number(
    execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ]).toString().trim(),
  );

// Slides listed here play a frame sequence instead of a still.
const animationsPath = join(episodeDir, "animations.json");
const animations = existsSync(animationsPath)
  ? JSON.parse(readFileSync(animationsPath, "utf8"))
  : {};

const segments = [];
let expected = 0;

console.log("slide   speech     held   source");
for (const clip of clips) {
  const n = clip.match(/(\d+)/)[1];
  const speech = duration(join(audioDir, clip));
  // Snap to a whole number of frames. A segment that ends part-way through a
  // frame leaves a short final frame, and once sixteen of those are joined the
  // result is no longer constant rate: players show it as a hitch at every
  // slide change.
  const held = Math.round((speech + gap) * fps) / fps;
  expected += held;

  const animName = animations[String(Number(n))];
  const animDir = animName ? join(frameDir, `anim-${animName}`) : null;
  const hasAnimation = animDir && existsSync(animDir) && readdirSync(animDir).length > 0;

  const seg = join(segDir, `seg-${n}.mp4`);
  const audioArgs = [
    "-i", join(audioDir, clip),
    // Pad the tail with silence rather than cutting the frame the instant the
    // sentence ends.
    "-af", `apad=pad_dur=${gap},aresample=${SAMPLE_RATE}`,
  ];
  const encodeArgs = [
    "-t", held.toFixed(4),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18",
    // Force constant frame rate. Without it ffmpeg is free to drop or duplicate
    // frames to hit the target duration, which is the other half of the stutter.
    "-fps_mode", "cfr", "-r", String(fps),
    "-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS),
    seg,
  ];

  let source;
  if (hasAnimation) {
    const frameCount = readdirSync(animDir).filter((f) => f.endsWith(".png")).length;
    const animSeconds = frameCount / fps;
    // The animation is almost always shorter than the narration, so clone the
    // last frame for the remainder instead of looping or speeding it up.
    const holdFor = Math.max(0, held - animSeconds);
    source = `${animName} (${animSeconds.toFixed(1)}s + ${holdFor.toFixed(1)}s hold)`;

    execFileSync("ffmpeg", [
      "-y",
      "-framerate", String(fps),
      "-i", join(animDir, "frame-%05d.png"),
      ...audioArgs,
      "-vf", `tpad=stop_mode=clone:stop_duration=${holdFor.toFixed(3)}`,
      ...encodeArgs,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    const frame = join(frameDir, `slide-${n}.png`);
    if (!existsSync(frame)) throw new Error(`missing frame for slide ${n}: ${frame}`);
    source = "still";

    execFileSync("ffmpeg", [
      "-y",
      "-loop", "1", "-framerate", String(fps), "-i", frame,
      ...audioArgs,
      ...encodeArgs,
    ], { stdio: ["ignore", "ignore", "pipe"] });
  }

  segments.push(seg);
  console.log(`  ${n}    ${speech.toFixed(1).padStart(6)}s  ${held.toFixed(1).padStart(6)}s   ${source}`);
}

const listPath = join(buildDir, "segments.txt");
writeFileSync(listPath, segments.map((s) => `file '${fwd(s)}'`).join("\n") + "\n", "utf8");

const out = join(buildDir, `${episode}.mp4`);
execFileSync("ffmpeg", [
  "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", out,
], { stdio: ["ignore", "ignore", "pipe"] });

const actual = duration(out);
const fmt = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
console.log(`\nexpected ${fmt(expected)}   actual ${fmt(actual)}   drift ${(actual - expected).toFixed(2)}s`);

if (Math.abs(actual - expected) > 1) {
  throw new Error(`assembled length is off by ${(actual - expected).toFixed(2)}s`);
}

// A frame count that does not match duration x fps means frames were dropped or
// duplicated somewhere, which is visible as a stutter rather than as an error.
const counted = Number(execFileSync("ffprobe", [
  "-v", "error", "-count_frames", "-select_streams", "v:0",
  "-show_entries", "stream=nb_read_frames",
  "-of", "default=nw=1:nk=1", out,
]).toString().trim());
const wanted = Math.round(expected * fps);
console.log(`frames: ${counted} counted, ${wanted} expected`);
if (Math.abs(counted - wanted) > 1) {
  throw new Error(`frame count is off by ${counted - wanted}; output is not constant rate`);
}

console.log(`done: ${out}`);
