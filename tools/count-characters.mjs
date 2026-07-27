// Report billable characters for an episode's voice over.
//
//   node tools/count-characters.mjs [--episode ep01]
//
// Neural TTS services bill per character, not per word or per minute, and they
// count whitespace and punctuation. Knowing the real number before committing to
// a vendor keeps the running cost of the channel honest.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const episode = argOf("--episode", "ep01");
const root = join(import.meta.dirname, "..");
const folder = readdirSync(join(root, "episodes"))
  .find((d) => d.startsWith(`${episode}-`) || d === episode);
if (!folder) throw new Error(`no episode folder for "${episode}"`);

const voDir = join(root, "episodes", folder, "vo");
const files = readdirSync(voDir).filter((f) => /^slide-\d+\.txt$/.test(f)).sort();

let total = 0;
let totalNoSpace = 0;
let words = 0;

for (const file of files) {
  const text = readFileSync(join(voDir, file), "utf8").trim();
  total += text.length;
  totalNoSpace += text.replace(/\s/g, "").length;
  words += text.split(/\s+/).filter(Boolean).length;
}

console.log(`${files.length} slides`);
console.log(`  words                 ${words.toLocaleString()}`);
console.log(`  characters            ${total.toLocaleString()}  <- what TTS bills`);
console.log(`  characters, no spaces ${totalNoSpace.toLocaleString()}`);
console.log(`\nper 52 weekly episodes: ${(total * 52).toLocaleString()} characters`);
console.log(`per 26 biweekly episodes: ${(total * 26).toLocaleString()} characters`);
