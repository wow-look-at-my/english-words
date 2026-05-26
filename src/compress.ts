import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { decompress } from "./decompress.js";

interface TrieNode {
  children: Map<number, TrieNode>;
  isEnd: boolean;
}

function compress(rawWords: string[]): Uint8Array {
  const sorted = [
    ...new Set(rawWords.map((w) => w.toLowerCase().trim()).filter(Boolean)),
  ].sort();

  const root: TrieNode = { children: new Map(), isEnd: false };
  for (const w of sorted) {
    let node = root;
    for (let i = 0; i < w.length; i++) {
      const ch = w.charCodeAt(i) - 97;
      let child = node.children.get(ch);
      if (!child) {
        child = { children: new Map(), isEnd: false };
        node.children.set(ch, child);
      }
      node = child;
    }
    node.isEnd = true;
  }

  const bytes: number[] = [];
  const n = sorted.length;
  bytes.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let b = ch & 0x1f;
      if (child.isEnd) b |= 0x20;
      if (child.children.size > 0) b |= 0x40;
      if (i === keys.length - 1) b |= 0x80;
      bytes.push(b);
      if (child.children.size > 0) serialize(child);
    }
  }

  serialize(root);
  return new Uint8Array(bytes);
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
].sort();

if (decoded.length !== expected.length) {
  console.error(`FAIL: expected ${expected.length} words, got ${decoded.length}`);
  process.exit(1);
}
for (let i = 0; i < expected.length; i++) {
  if (decoded[i] !== expected[i]) {
    console.error(`FAIL at ${i}: expected "${expected[i]}", got "${decoded[i]}"`);
    process.exit(1);
  }
}

const rawSize = text.length;
const binSize = bin.length;
const gzSize = gz.length;
console.log(`${expected.length} words compressed:`);
console.log(`  Raw text:      ${rawSize} bytes (${(rawSize / 1024).toFixed(0)} KB)`);
console.log(`  dict.bin:      ${binSize} bytes (${(binSize / 1024).toFixed(0)} KB) [${((binSize / rawSize) * 100).toFixed(1)}%]`);
console.log(`  dict.bin.gz:   ${gzSize} bytes (${(gzSize / 1024).toFixed(0)} KB) [${((gzSize / rawSize) * 100).toFixed(1)}%]`);
console.log("Roundtrip: OK");
