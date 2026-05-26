import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// ─── Load words ───────────────────────────────────────────────────────
const text = readFileSync("words_alpha.txt", "utf-8");
const words = [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((w) => w.toLowerCase().trim())
      .filter(Boolean)
  ),
].sort();

console.log(`Loaded ${words.length} words`);

// ─── Helper ──────────────────────────────────────────────────────────
interface Result {
  name: string;
  rawBytes: number;
  gzBytes: number;
}
const results: Result[] = [];

function measure(name: string, data: Uint8Array): Result {
  const gz = gzipSync(Buffer.from(data), { level: 9 });
  const r = { name, rawBytes: data.length, gzBytes: gz.length };
  results.push(r);
  return r;
}

// ─── Build trie ────────────────────────────────────────────────────
interface TrieNode {
  children: Map<number, TrieNode>;
  isEnd: boolean;
}

const root: TrieNode = { children: new Map(), isEnd: false };
for (const w of words) {
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

// ─── I. DFS trie baseline ─────────────────────────────────────────
function encodeDFSTrie(root: TrieNode, wordCount: number): Uint8Array {
  const buf: number[] = [];
  const n = wordCount;
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
      if (child.children.size > 0) {
        serialize(child);
      }
    }
  }
  serialize(root);
  return new Uint8Array(buf);
}

// Decoder (this is what needs to be ~100 lines of TypeScript):
function decodeDFSTrie(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(0, true);
  const result: string[] = new Array(count);
  let wi = 0;
  let pos = 4;
  const stack: number[] = []; // char codes building current prefix

  function decode() {
    while (pos < data.length) {
      const byte = data[pos++];
      const ch = byte & 0x1f;
      const isEnd = !!(byte & 0x20);
      const hasChildren = !!(byte & 0x40);
      const isLast = !!(byte & 0x80);

      stack.push(ch + 97);
      if (isEnd) {
        result[wi++] = String.fromCharCode(...stack);
      }
      if (hasChildren) {
        decode();
      }
      stack.pop();
      if (isLast) return;
    }
  }
  decode();
  return result;
}

const trieBin = encodeDFSTrie(root, words.length);
measure("I. DFS trie baseline", trieBin);

// Verify decoder
const decoded = decodeDFSTrie(trieBin);
if (decoded.length !== words.length) {
  console.error(`FAIL: expected ${words.length}, got ${decoded.length}`);
} else {
  let ok = true;
  for (let i = 0; i < words.length; i++) {
    if (decoded[i] !== words[i]) {
      console.error(`FAIL at ${i}: expected "${words[i]}", got "${decoded[i]}"`);
      ok = false;
      break;
    }
  }
  if (ok) console.log("DFS trie decoder: roundtrip OK");
}

// ─── Try further micro-optimizations on the winning trie format ───

// ─── I-A. What if we DON'T include wordCount header? (saves 4 bytes, trivial) ───
// ─── I-B. What if we use isEnd as a flag on the PARENT edge to the child? ───
// (Already doing this.)

// ─── I-C. Omit leaf nodes entirely: if hasChildren=0, just mark isEnd ───
// (Already doing this -- leaves are just edges with no recursion.)

// ─── I-D. For leaf edges (hasChildren=0, isEnd=1, isLast varies): these are 2-bit flags + 5-bit char ───
// Can we pack more efficiently? Leaf edges = 282574 edges.
// 27.5% of all edges are leaves (no children, isEnd=1).
// But also edges with children can be end-of-word.

// ─── I-E. Analyze: what % of edges have which flag combinations? ───
{
  const flagCounts = new Map<number, number>();
  function countFlags(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const child = node.children.get(keys[i])!;
      let flags = 0;
      if (child.isEnd) flags |= 1;
      if (child.children.size > 0) flags |= 2;
      if (i === keys.length - 1) flags |= 4;
      flagCounts.set(flags, (flagCounts.get(flags) ?? 0) + 1);
    }
  }
  countFlags(root);

  // Wait, need to recurse
  function countFlagsR(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const child = node.children.get(keys[i])!;
      let flags = 0;
      if (child.isEnd) flags |= 1;
      if (child.children.size > 0) flags |= 2;
      if (i === keys.length - 1) flags |= 4;
      flagCounts.set(flags, (flagCounts.get(flags) ?? 0) + 1);
      if (child.children.size > 0) countFlagsR(child);
    }
  }
  flagCounts.clear();
  countFlagsR(root);

  console.log("\nEdge flag combinations:");
  const flagLabels = ["", "end", "hasCh", "end+hasCh", "last", "last+end", "last+hasCh", "last+end+hasCh"];
  for (let i = 0; i < 8; i++) {
    const count = flagCounts.get(i) ?? 0;
    console.log(`  ${flagLabels[i].padEnd(20)}: ${count.toString().padStart(7)} (${(count / 1027809 * 100).toFixed(1)}%)`);
  }
}

// ─── I-F. What about storing only edges with hasChildren=1, and encoding leaf sets differently? ───
// For example: at each branching node, store which chars are end-of-word leaves as a bitmask,
// then store which chars have children as edges.
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeHybrid(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);

    // Separate children into: leaf (no children) and branch (has children)
    const leafChars: number[] = [];
    const branchChars: number[] = [];
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      if (child.children.size === 0) {
        // Leaf: must be end-of-word (otherwise it's unreachable)
        leafChars.push(ch);
      } else {
        branchChars.push(ch);
      }
    }

    // Encode: first byte = leafCount | (branchCount << 4) -- but both could be > 15
    // Let's use: leafCount:u8, branchCount:u8
    // Then leafCount char bytes (all are isEnd=true by definition)
    // Then branchCount entries: char|isEnd byte, followed by recursive children
    buf.push(leafChars.length);
    buf.push(branchChars.length);
    for (const ch of leafChars) buf.push(ch); // 0-25
    for (const ch of branchChars) {
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      buf.push(byte);
    }
    // Recurse into branch children
    for (const ch of branchChars) {
      serializeHybrid(node.children.get(ch)!);
    }
  }
  serializeHybrid(root);
  measure("I-F. DFS trie hybrid (leaf chars + branch chars)", new Uint8Array(buf));
}

// ─── I-G. What if we use a different encoding for the isLast flag? ───
// Instead of isLast bit per edge, use child_count before each node's children.
// But only 1 byte per node vs 1 bit per edge. For nodes with many children, this saves.
// For nodes with 1 child (58.3%), this costs 1 byte vs 0 bits (since isLast is implicit for single child).
// Net: adds 1 byte per node (1027810 bytes) but saves 0 bits on the isLast flag (already 1 bit per edge).
// This is worse. Skip.

// ─── I-H. What if we merge the root encoding? Root has 26 children. ───
// Skip -- gzip handles the root fine.

// ─── I-J. Try: DFS trie but with sorted children in REVERSE order ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeReverse(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => b - a); // reverse!
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) {
        serializeReverse(child);
      }
    }
  }
  serializeReverse(root);
  measure("I-J. DFS trie (reverse-sorted children)", new Uint8Array(buf));
}

// ─── I-K. Try: only isEnd and isLast flags (no hasChildren). Use child_count prefix per node. ───
// 2 flag bits + 5 char bits = 7 bits per edge. But we'd need the child_count too.
// Actually: without hasChildren, we can't tell if there are children.
// Alternative: always recurse, and use child_count = 0 for leaves.
// This means 2 bytes per leaf (the edge byte + a 0x00 child count).
// Let's see: 282574 leaves * 1 extra byte each = 282 KB overhead.
// But we save 1 bit per non-leaf edge. At 745235 non-leaf edges, that's ~91 KB saved.
// Net: +191 KB. Bad. Skip.

// ─── I-L. Try: global front-coded + DFS trie hybrid ───
// The global front-coded approach E + the DFS trie I are fundamentally different.
// Front-coding works on the sorted list; trie works on the prefix tree.
// The trie wins because it captures shared structure more efficiently:
// - Each unique prefix is stored exactly once (as a path in the trie)
// - Front-coding stores each prefix as a share+suffix pair, which is redundant for
//   words that share prefixes but aren't adjacent in sorted order.
// Actually wait -- in sorted order, words sharing a prefix ARE adjacent. So front-coding
// should be equivalent... but the trie still wins because:
// - The trie encoding is more compact: 1 byte per edge vs share+26 + suffix chars
// - The trie naturally encodes the branching structure, which gzip can exploit

// ─── I-M. DFS trie with optimized byte layout: put char in upper 5 bits ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeUpper(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      // Put char in upper 5 bits (bits 3-7), flags in lower 3 bits
      let byte = (ch << 3);
      if (child.isEnd) byte |= 0x01;
      if (child.children.size > 0) byte |= 0x02;
      if (i === keys.length - 1) byte |= 0x04;
      buf.push(byte);
      if (child.children.size > 0) {
        serializeUpper(child);
      }
    }
  }
  serializeUpper(root);
  measure("I-M. DFS trie (char in upper 5 bits)", new Uint8Array(buf));
}

// ─── I-N. What if we omit the isEnd flag by using a separate bitmap? ───
{
  // Observation: isEnd is set on 370105 out of 1027809 edges (36%).
  // If we store isEnd as a separate bitstream, the edge bytes only need 2 flags + 5 char bits = 7 bits.
  // We can use the freed bit for something else, or pack edges more.

  // Store: DFS edge bytes (char | hasChildren<<6 | isLast<<7), then a bitmap of isEnd flags
  const edgeBytes: number[] = [];
  const endBits: number[] = [];

  function serializeSepEnd(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch; // 0-25, uses 5 bits
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      edgeBytes.push(byte);
      endBits.push(child.isEnd ? 1 : 0);
      if (child.children.size > 0) {
        serializeSepEnd(child);
      }
    }
  }
  serializeSepEnd(root);

  // Pack endBits into bytes
  const packedEnd: number[] = [];
  for (let i = 0; i < endBits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8 && i + j < endBits.length; j++) {
      byte |= endBits[i + j] << j;
    }
    packedEnd.push(byte);
  }

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  const eLen = edgeBytes.length;
  buf.push(eLen & 0xff, (eLen >> 8) & 0xff, (eLen >> 16) & 0xff, (eLen >> 24) & 0xff);
  for (const v of edgeBytes) buf.push(v);
  for (const v of packedEnd) buf.push(v);
  measure("I-N. DFS trie (separate isEnd bitmap)", new Uint8Array(buf));
}

// ─── I-O. What if we omit isLast and hasChildren, store just char|isEnd, with child counts? ───
// Already tried as I15 and I-F. Both worse.

// ─── I-P. DFS trie but pack 2 edges per 2 bytes (10 bits per edge) ───
// 5 bits char + 3 flags + 2 spare. Alignment issues. Skip.

// ─── I-Q. Filtered output: only emit "interesting" edges (branching points and end-of-word) ───
// Path compression variant. Already tried as I13, was worse due to gzip.

// ─── I-R. Try gzip levels ───
{
  console.log("\n─── Gzip level sensitivity (DFS trie I) ───");
  for (let level = 1; level <= 9; level++) {
    const gz = gzipSync(Buffer.from(trieBin), { level });
    console.log(`  level ${level}: ${(gz.length / 1024).toFixed(0)} KB`);
  }
}

// ─── I-S. Try brotli ───
{
  const { brotliCompressSync, constants } = await import("node:zlib");
  const br = brotliCompressSync(Buffer.from(trieBin), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
    },
  });
  console.log(`\n  Brotli (max quality): ${(br.length / 1024).toFixed(0)} KB`);
}

// ─── Print results ───────────────────────────────────────────────────
console.log("\n═══ EXTENDED TRIE VARIANT COMPARISON ═══\n");
console.log(
  "│ " +
    "Approach".padEnd(55) +
    " │ " +
    "Raw KB".padStart(8) +
    " │ " +
    "GZ KB".padStart(8) +
    " │"
);
console.log("│" + "─".repeat(57) + "│" + "─".repeat(10) + "│" + "─".repeat(10) + "│");

const sortedResults = [...results].sort((a, b) => a.gzBytes - b.gzBytes);
for (const r of sortedResults) {
  const rawKB = (r.rawBytes / 1024).toFixed(0);
  const gzKB = (r.gzBytes / 1024).toFixed(0);
  console.log(
    "│ " +
      r.name.padEnd(55).slice(0, 55) +
      " │ " +
      rawKB.padStart(8) +
      " │ " +
      gzKB.padStart(8) +
      " │"
  );
}

// ─── Decoder line count ───────────────────────────────────────────
console.log("\n─── DFS Trie Decoder (TypeScript) ───");
console.log("Lines of code for decoder: ~25 lines");
console.log(`
export function decompress(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(0, true);
  const result: string[] = new Array(count);
  let wi = 0;
  let pos = 4;
  const stack: number[] = [];

  function decode() {
    while (pos < data.length) {
      const b = data[pos++];
      stack.push((b & 0x1f) + 97);
      if (b & 0x20) result[wi++] = String.fromCharCode(...stack);
      if (b & 0x40) decode();
      stack.pop();
      if (b & 0x80) return;
    }
  }
  decode();
  return result;
}
`);
