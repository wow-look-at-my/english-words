import { readFileSync, writeFileSync } from "node:fs";
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

// --- Build to repo root (Pages serves from master /) ---
const text = readFileSync("words_alpha.txt", "utf-8");
const words = text.split(/\r?\n/).filter((w) => w.trim());

const bin = compress(words);
writeFileSync("words_alpha.dict.bin", bin);

const gz = gzipSync(Buffer.from(bin), { level: 9 });
writeFileSync("words_alpha.dict.bin.gz", gz);

writeFileSync(".nojekyll", "");

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

// Generate index.html with accurate sizes
const html = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>English Words Dictionary</title>",
  "<style>",
  "body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}",
  "table{border-collapse:collapse;width:100%}",
  "th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}",
  "code{background:#f4f4f4;padding:2px 6px;border-radius:3px}",
  "pre{background:#f4f4f4;padding:16px;border-radius:6px;overflow-x:auto}",
  ".r{text-align:right;font-variant-numeric:tabular-nums}",
  "</style>",
  "</head>",
  "<body>",
  "<h1>English Words Dictionary</h1>",
  `<p>${expected.length.toLocaleString()} English words served via GitHub Pages.</p>`,
  "<h2>Files</h2>",
  "<table>",
  "<tr><th>File</th><th>Format</th><th class=r>Size</th></tr>",
  `<tr><td><a href="words_alpha.dict.bin">words_alpha.dict.bin</a></td><td>Binary (length-grouped, front-coded)</td><td class=r>${(binSize / 1024).toFixed(0)} KB</td></tr>`,
  `<tr><td><a href="words_alpha.dict.bin.gz">words_alpha.dict.bin.gz</a></td><td>Gzipped binary</td><td class=r>${(gzSize / 1024).toFixed(0)} KB</td></tr>`,
  `<tr><td><a href="words_alpha.txt">words_alpha.txt</a></td><td>Plain text</td><td class=r>${(rawSize / 1024).toFixed(0)} KB</td></tr>`,
  "</table>",
  "<h2>Usage</h2>",
  "<pre><code>import { decompress } from './decompress.js';",
  "",
  "const resp = await fetch('words_alpha.dict.bin');",
  "const buf = new Uint8Array(await resp.arrayBuffer());",
  `const words = decompress(buf); // ${expected.length} words</code></pre>`,
  "<h2>Format (EWD v2)</h2>",
  "<p>Words are grouped by length and front-coded within each group.</p>",
  "<pre><code>Header: 'EWD' 0x02 max_len:u8 counts[max_len]:u32le",
  "Body per group (length L, count C):",
  "  C words, each: shared:u8 suffix[L-shared]:u8 (char = 0..25)",
  "  sorted alphabetically, front-coded against previous word</code></pre>",
  "</body>",
  "</html>",
].join("\n");
writeFileSync("index.html", html);
