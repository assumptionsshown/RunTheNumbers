// Assemble an episode: one still frame per slide, held for exactly as long as
// that slide's voice over runs, plus a short breath between slides.
//
//   node tools/build-video.mjs [--episode ep01] [--gap 0.7] [--fps 30] [--resume]
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
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const episode = argOf("--episode", "ep01");
const gap = Number(argOf("--gap", "0.7"));
const fps = Number(argOf("--fps", "30"));
const resume = args.includes("--resume");

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

const isReusableSegment = (file, held) => {
  if (!resume || !existsSync(file) || statSync(file).size === 0) return false;
  try {
    return Math.abs(duration(file) - held) <= (1 / fps + 0.01);
  } catch {
    // An interrupted ffmpeg run can leave a non-empty MP4 without its final
    // metadata atom. Treat that file as incomplete and encode it again.
    return false;
  }
};

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

  const animName = animations[String(Number(n))];
  const animDir = animName ? join(frameDir, `anim-${animName}`) : null;
  const hasAnimation = animDir && existsSync(animDir) && readdirSync(animDir).length > 0;
  const animFrames = hasAnimation
    ? readdirSync(animDir).filter((f) => f.endsWith(".png")).length
    : 0;
  const animSeconds = animFrames / fps;

  // TIMING AUTHORITY, inverted 2026-09-04.
  //
  // This used to be `(speech + gap)` alone, which made the NARRATION the master
  // clock: a slide ran for exactly as long as its WAV, and an animation longer
  // than its narration was silently truncated by `-t held`. That is right for a
  // deck read aloud and wrong for the format the founder authorised on 09-01,
  // where the instrument carries load the words used to and the script gets
  // SHORTER. Under the old rule every movement would have been cut off at the new,
  // shorter narration length, and the beat that most wants to outrun its words
  // would have been cut hardest.
  //
  // Now the longer of the two wins: narration is never clipped, and a movement is
  // never clipped either. For every existing episode the animations are shorter
  // than their narration, so this is a no-op on them and their durations do not
  // move; the log line below fires only when an animation is actually the master.
  //
  // Snap to a whole number of frames. A segment that ends part-way through a
  // frame leaves a short final frame, and once sixteen of those are joined the
  // result is no longer constant rate: players show it as a hitch at every
  // slide change.
  const narrated = speech + gap;
  const held = Math.round(Math.max(narrated, animSeconds) * fps) / fps;
  if (hasAnimation && animSeconds > narrated) {
    console.log(`  slide ${n}: movement is the master clock, ${animSeconds.toFixed(1)}s over ${narrated.toFixed(1)}s of narration`);
  }
  expected += held;

  const seg = join(segDir, `seg-${n}.mp4`);
  const audioArgs = [
    "-i", join(audioDir, clip),
    // Pad the tail with silence rather than cutting the frame the instant the
    // sentence ends.
    "-af", `apad=pad_dur=${gap},aresample=${SAMPLE_RATE}`,
  ];
  const encodeArgs = [
    "-t", held.toFixed(4),
    // CRF lowered from 18 and tuned for still content on 2026-08-29. These slides
    // are mostly a static frame held for half a minute, and at CRF 18 x264 was
    // re-quantising the thin footer rule differently at each keyframe, which reads
    // as a line that pulses every few seconds. The rule's contrast was raised in
    // slides.css at the same time; both were needed.
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "16",
    "-tune", "stillimage",
    // Force constant frame rate. Without it ffmpeg is free to drop or duplicate
    // frames to hit the target duration, which is the other half of the stutter.
    "-fps_mode", "cfr", "-r", String(fps),
    "-c:a", "aac", "-b:a", "192k", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS),
    seg,
  ];

  let source;
  const reusable = isReusableSegment(seg, held);

  if (reusable) {
    source = "existing segment";
  } else if (hasAnimation) {
    // Clone the last frame for any remainder rather than looping or speeding up.
    // With the inverted authority above this is zero whenever the movement is the
    // master, and the movement plays whole.
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
