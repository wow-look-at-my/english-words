import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { decompress } from "./decompress.js";

function compress(rawWords: string[]): Uint8Array {
  const clean = [
    ...new Set(rawWords.map((w) => w.toLowerCase().trim()).filter(Boolean)),
  ];

  const groups = new Map<number, string[]>();
  let maxLen = 0;
  for (const w of clean) {
    if (w.length > maxLen) maxLen = w.length;
    let g = groups.get(w.length);
    if (!g) {
      g = [];
      groups.set(w.length, g);
    }
    g.push(w);
  }
  for (const g of groups.values()) g.sort();

  const buf: number[] = [];

  buf.push(69, 87, 68, 2, maxLen);
  for (let i = 0; i < maxLen; i++) {
    const c = groups.get(i + 1)?.length ?? 0;
    buf.push(c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, (c >> 24) & 0xff);
  }

  for (let len = 1; len <= maxLen; len++) {
    const g = groups.get(len);
    if (!g) continue;
    let prev = "";
    for (const w of g) {
      let shared = 0;
      while (
        shared < prev.length &&
        shared < w.length &&
        prev[shared] === w[shared]
      ) {
        shared++;
      }
      buf.push(shared);
      for (let i = shared; i < w.length; i++) {
        buf.push(w.charCodeAt(i) - 97);
      }
      prev = w;
    }
  }

  return new Uint8Array(buf);
}

const S = "site";
mkdirSync(S, { recursive: true });

const text = readFileSync("words_alpha.txt", "utf-8");
const words = text.split(/\r?\n/).filter((w) => w.trim());

const bin = compress(words);
writeFileSync(`${S}/words_alpha.dict.bin`, bin);

const gz = gzipSync(Buffer.from(bin), { level: 9 });
writeFileSync(`${S}/words_alpha.dict.bin.gz`, gz);

copyFileSync("words_alpha.txt", `${S}/words_alpha.txt`);

for (const f of readdirSync("src/site")) {
  copyFileSync(join("src/site", f), join(S, f));
}

// Roundtrip verification
const decoded = decompress(bin);
const expected = [
  ...new Set(words.map((w) => w.toLowerCase().trim()).filter(Boolean)),
].sort((a, b) => a.length - b.length || a.localeCompare(b));

if (decoded.length !== expected.length) {
  console.error(
    `FAIL: expected ${expected.length} words, got ${decoded.length}`
  );
  process.exit(1);
}
for (let i = 0; i < expected.length; i++) {
  if (decoded[i] !== expected[i]) {
    console.error(
      `FAIL at ${i}: expected "${expected[i]}", got "${decoded[i]}"`
    );
    process.exit(1);
  }
}

const rawSize = text.length;
const binSize = bin.length;
const gzSize = gz.length;
console.log(`${expected.length} words compressed:`);
console.log(
  `  Raw text:      ${rawSize} bytes (${(rawSize / 1024).toFixed(0)} KB)`
);
console.log(
  `  dict.bin:      ${binSize} bytes (${(binSize / 1024).toFixed(0)} KB) [${((binSize / rawSize) * 100).toFixed(1)}%]`
);
console.log(
  `  dict.bin.gz:   ${gzSize} bytes (${(gzSize / 1024).toFixed(0)} KB) [${((gzSize / rawSize) * 100).toFixed(1)}%]`
);
console.log("Roundtrip: OK");
