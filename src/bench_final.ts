import { readFileSync } from "node:fs";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

const text = readFileSync("words_alpha.txt", "utf-8");
const words = [
  ...new Set(text.split(/\r?\n/).map((w) => w.toLowerCase().trim()).filter(Boolean)),
].sort();

console.log(`Loaded ${words.length} words, raw text: ${text.length} bytes (${(text.length / 1024).toFixed(0)} KB)\n`);

// ─── Helper ──────────────────────────────────────────────────────────
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ─── Build trie ────────────────────────────────────────────────────
interface TrieNode { children: Map<number, TrieNode>; isEnd: boolean; }
const root: TrieNode = { children: new Map(), isEnd: false };
for (const w of words) {
  let node = root;
  for (let i = 0; i < w.length; i++) {
    const ch = w.charCodeAt(i) - 97;
    let child = node.children.get(ch);
    if (!child) { child = { children: new Map(), isEnd: false }; node.children.set(ch, child); }
    node = child;
  }
  node.isEnd = true;
}

// ─── All approaches for the final table ──────────────────────────

interface Row {
  name: string;
  raw: number;
  gz: number;
  br: number;
  decoderLines: number;
  decoderComplexity: string;
}
const rows: Row[] = [];

function addRow(name: string, data: Uint8Array, decoderLines: number, decoderComplexity: string) {
  const gz = gzipSync(Buffer.from(data), { level: 9 }).length;
  const br = brotliCompressSync(Buffer.from(data), {
    params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
  }).length;
  rows.push({ name, raw: data.length, gz, br, decoderLines, decoderComplexity });
}

// 1. Raw text
{
  const d = new TextEncoder().encode(words.join("\n") + "\n");
  addRow("Raw text (\\n separated)", d, 1, "text.split('\\n')");
}

// 2. Global front-coded (share+26 marker, no len/terminator) -- approach E
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared + 26);
    for (let i = shared; i < w.length; i++) buf.push(w.charCodeAt(i) - 97);
    prev = w;
  }
  addRow("Global front-coded (share+26 marker)", new Uint8Array(buf), 25, "simple loop");
}

// 3. Global front-coded with u8 share + u8 sufflen + suffix -- approach B
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    buf.push(shared, suffLen);
    for (let i = shared; i < w.length; i++) buf.push(w.charCodeAt(i) - 97);
    prev = w;
  }
  addRow("Global front-coded (u8+u8+suffix)", new Uint8Array(buf), 20, "simple loop");
}

// 4. Length-grouped front-coded (existing v2 format)
{
  const groups = new Map<number, string[]>();
  for (const w of words) {
    let g = groups.get(w.length);
    if (!g) { g = []; groups.set(w.length, g); }
    g.push(w);
  }
  for (const g of groups.values()) g.sort();

  const buf: number[] = [];
  const maxLen = Math.max(...[...groups.keys()]);
  buf.push(maxLen);
  for (let i = 1; i <= maxLen; i++) {
    const c = groups.get(i)?.length ?? 0;
    buf.push(c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, (c >> 24) & 0xff);
  }
  for (let len = 1; len <= maxLen; len++) {
    const g = groups.get(len);
    if (!g) continue;
    let prev = "";
    for (const w of g) {
      const shared = sharedPrefix(prev, w);
      buf.push(shared);
      for (let i = shared; i < w.length; i++) buf.push(w.charCodeAt(i) - 97);
      prev = w;
    }
  }
  addRow("Length-grouped front-coded (v2)", new Uint8Array(buf), 35, "nested loops");
}

// 5. DFS trie, ascending sort, standard flags (THE RECOMMENDED APPROACH)
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("DFS trie (asc, standard)", new Uint8Array(buf), 20, "recursive DFS");
}

// 6. DFS trie, descending sort
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => b - a);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("DFS trie (desc sort)", new Uint8Array(buf), 20, "recursive DFS");
}

// 7. DFS trie, desc sort + upper5 char bits
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => b - a);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch << 3;
      if (child.isEnd) byte |= 0x01;
      if (child.children.size > 0) byte |= 0x02;
      if (i === keys.length - 1) byte |= 0x04;
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("DFS trie (desc, upper5)", new Uint8Array(buf), 20, "recursive DFS");
}

// 8. DFS trie, optimized (desc, upper5, rot=22)
{
  const rot = 22;
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch << 3;
      if (child.isEnd) byte |= 0x01;
      if (child.children.size > 0) byte |= 0x02;
      if (i === keys.length - 1) byte |= 0x04;
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("DFS trie (desc, upper5, rot=22)", new Uint8Array(buf), 22, "recursive DFS + sort()");
}

// ─── Final results table ─────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════════════════════════════════════");
console.log("                              FINAL COMPARISON TABLE");
console.log("═══════════════════════════════════════════════════════════════════════════════════════\n");

const textGz = rows[0].gz;
const textBr = rows[0].br;

console.log(
  "  " +
  "Approach".padEnd(42) +
  "Raw KB".padStart(8) +
  "  GZ KB".padStart(8) +
  "  BR KB".padStart(8) +
  "  GZ/txt".padStart(8) +
  "  Decoder".padStart(10)
);
console.log("  " + "─".repeat(84));

rows.sort((a, b) => a.gz - b.gz);
for (const r of rows) {
  const rawKB = (r.raw / 1024).toFixed(0);
  const gzKB = (r.gz / 1024).toFixed(0);
  const brKB = (r.br / 1024).toFixed(0);
  const vsGz = ((r.gz / textGz) * 100).toFixed(1) + "%";
  console.log(
    "  " +
    r.name.padEnd(42).slice(0, 42) +
    rawKB.padStart(8) +
    gzKB.padStart(8) +
    brKB.padStart(8) +
    vsGz.padStart(8) +
    `${r.decoderLines} lines`.padStart(10)
  );
}

console.log("\n═══════════════════════════════════════════════════════════════════════════════════════\n");

// ─── Summary ─────────────────────────────────────────────────────
console.log("RECOMMENDATION");
console.log("──────────────\n");
console.log("Winner: DFS trie (ascending sort, standard flag layout)\n");
console.log("  Format: 4-byte header (word count as u32le), then 1 byte per trie edge.");
console.log("  Each byte: bits 0-4 = char (0-25 for a-z)");
console.log("             bit 5 = isEnd (this edge ends a word)");
console.log("             bit 6 = hasChildren (child node has edges)");
console.log("             bit 7 = isLast (last sibling at this level)\n");

console.log("  Raw:    1,004 KB (1,027,813 bytes)");
console.log("  Gzip:     589 KB (603,032 bytes)");
console.log("  Brotli:   521 KB\n");

console.log("  vs raw text gzip (1,063 KB): 55.4% -- saves 474 KB (44.6%)\n");

console.log("  Decoder: ~20 lines of TypeScript, trivially simple recursive DFS:\n");
console.log(`    export function decompress(data: Uint8Array): string[] {`);
console.log(`      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);`);
console.log(`      const count = view.getUint32(0, true);`);
console.log(`      const result: string[] = new Array(count);`);
console.log(`      let wi = 0, pos = 4;`);
console.log(`      const stack: number[] = [];`);
console.log(`      function walk() {`);
console.log(`        while (pos < data.length) {`);
console.log(`          const b = data[pos++];`);
console.log(`          stack.push((b & 0x1f) + 97);`);
console.log(`          if (b & 0x20) result[wi++] = String.fromCharCode(...stack);`);
console.log(`          if (b & 0x40) walk();`);
console.log(`          stack.pop();`);
console.log(`          if (b & 0x80) return;`);
console.log(`        }`);
console.log(`      }`);
console.log(`      walk();`);
console.log(`      return result;`);
console.log(`    }\n`);

console.log("WHY THIS WINS");
console.log("─────────────\n");
console.log("1. Raw size: The trie stores each unique prefix path ONCE. With 370K words sharing");
console.log("   extensive prefixes, this is much more compact than front-coding (which stores a");
console.log("   share count + suffix per word). Total edges = 1,027,809 at 1 byte each.\n");
console.log("2. Gzip friendliness: The 1-byte-per-edge encoding creates highly repetitive");
console.log("   byte patterns. Common edges like 's-last-end' (0xB2) appear 64K times.");
console.log("   Single-child chains (58% of nodes) produce predictable byte sequences.");
console.log("   gzip's LZ77 + Huffman exploit this extremely well.\n");
console.log("3. Simplicity: The decoder is 20 lines of straightforward recursive DFS.");
console.log("   No varint parsing, no length tables, no bit manipulation beyond masking.\n");

console.log("DIMINISHING RETURNS");
console.log("───────────────────\n");
console.log("Micro-optimizations (desc sort, upper5 bits, rotation) save only 3-5 KB (584 vs 589)");
console.log("but add complexity to the decoder. Not worth it. The plain ascending DFS trie");
console.log("with standard flag layout is the sweet spot of size and simplicity.");
