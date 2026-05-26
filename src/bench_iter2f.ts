import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const text = readFileSync("words_alpha.txt", "utf-8");
const words = [
  ...new Set(text.split(/\r?\n/).map((w) => w.toLowerCase().trim()).filter(Boolean)),
].sort();

console.log(`Loaded ${words.length} words\n`);

// Build trie
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
    if (!child) { child = { children: new Map(), isEnd: false }; node.children.set(ch, child); }
    node = child;
  }
  node.isEnd = true;
}

interface Row { name: string; raw: number; gz: number; }
const rows: Row[] = [];

function addRow(name: string, data: Uint8Array) {
  const gz = gzipSync(Buffer.from(data), { level: 9 }).length;
  rows.push({ name, raw: data.length, gz });
  console.log(`  ${name}: raw=${(data.length/1024).toFixed(0)} KB, gz=${gz} bytes (${(gz/1024).toFixed(0)} KB)`);
  return gz;
}

// Baseline
console.log("=== BASELINES ===");
let baselineGz: number;
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
  baselineGz = addRow("BASELINE: DFS standard", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// BPE OPTIMIZATION
// The key insight: BPE on combo-mapped gave 586 KB.
// Let's test BPE on different base encodings and with more merges.
// ═══════════════════════════════════════════════════════════════════════

// Generate base DFS bytes for various configs
function genComboMapped(rot: number, sortDir: "asc" | "desc"): { edges: Uint8Array; comboOrder: number[] } {
  const comboCounts = new Array(8).fill(0);

  interface Edge { combo: number; ch: number; }
  const edges: Edge[] = [];

  function collectEdges(node: TrieNode) {
    const keys = [...node.children.keys()];
    if (sortDir === "asc") {
      keys.sort((a, b) => ((a + rot) % 26) - ((b + rot) % 26));
    } else {
      keys.sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    }
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      comboCounts[combo]++;
      edges.push({ combo, ch });
      if (child.children.size > 0) collectEdges(child);
    }
  }
  collectEdges(root);

  const comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);
  const comboToIdx = new Array(8);
  for (let i = 0; i < 8; i++) comboToIdx[comboOrder[i]] = i;

  return {
    edges: new Uint8Array(edges.map(e => e.ch + comboToIdx[e.combo] * 26)),
    comboOrder,
  };
}

function genStandardDFS(rot: number, sortDir: "asc" | "desc", layout: "lower5" | "upper5"): Uint8Array {
  const buf: number[] = [];
  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()];
    if (sortDir === "asc") {
      keys.sort((a, b) => ((a + rot) % 26) - ((b + rot) % 26));
    } else {
      keys.sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    }
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte: number;
      if (layout === "lower5") {
        byte = ch;
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
      } else {
        byte = ch << 3;
        if (child.isEnd) byte |= 0x01;
        if (child.children.size > 0) byte |= 0x02;
        if (i === keys.length - 1) byte |= 0x04;
      }
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  return new Uint8Array(buf);
}

// BPE engine
function applyBPE(data: Uint8Array, maxSymbol: number, maxMerges: number): { merged: Uint8Array; mergeTable: [number, number][]; startSymbol: number } {
  let current = Array.from(data);
  let nextSymbol = maxSymbol;
  const mergeTable: [number, number][] = [];

  for (let iter = 0; iter < maxMerges && nextSymbol < 65536; iter++) {
    // Count pairs
    const pairs = new Map<number, number>();
    for (let j = 0; j < current.length - 1; j++) {
      const key = current[j] * 65536 + current[j + 1];
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }

    // Find most frequent pair
    let bestPair = 0, bestCount = 0;
    for (const [pair, count] of pairs) {
      if (count > bestCount) { bestCount = count; bestPair = pair; }
    }

    if (bestCount < 2) break;

    const a = bestPair >> 16, b = bestPair & 0xffff;
    mergeTable.push([a, b]);

    // Replace all occurrences
    const newData: number[] = [];
    let j = 0;
    while (j < current.length) {
      if (j < current.length - 1 && current[j] === a && current[j + 1] === b) {
        newData.push(nextSymbol);
        j += 2;
      } else {
        newData.push(current[j]);
        j++;
      }
    }
    current = newData;
    nextSymbol++;
  }

  return {
    merged: new Uint8Array(current.map(v => v & 0xff)), // may need 16-bit
    mergeTable,
    startSymbol: maxSymbol,
  };
}

// BPE with 16-bit encoding for symbols > 255
function applyBPE16(data: Uint8Array, maxSymbol: number, maxMerges: number): { symbols: number[]; mergeTable: [number, number][] } {
  let current = Array.from(data);
  let nextSymbol = maxSymbol;
  const mergeTable: [number, number][] = [];

  for (let iter = 0; iter < maxMerges; iter++) {
    const pairs = new Map<number, number>();
    for (let j = 0; j < current.length - 1; j++) {
      const key = current[j] * 65536 + current[j + 1];
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }

    let bestPair = 0, bestCount = 0;
    for (const [pair, count] of pairs) {
      if (count > bestCount) { bestCount = count; bestPair = pair; }
    }

    if (bestCount < 2) break;

    const a = bestPair >> 16, b = bestPair & 0xffff;
    mergeTable.push([a, b]);

    const newData: number[] = [];
    let j = 0;
    while (j < current.length) {
      if (j < current.length - 1 && current[j] === a && current[j + 1] === b) {
        newData.push(nextSymbol);
        j += 2;
      } else {
        newData.push(current[j]);
        j++;
      }
    }
    current = newData;
    nextSymbol++;
  }

  return { symbols: current, mergeTable };
}

console.log("\n=== BPE on combo-mapped desc r22 with varying merge counts ===");
{
  const { edges, comboOrder } = genComboMapped(22, "desc");
  console.log(`  Base data: ${edges.length} bytes, ${new Set(edges).size} unique values`);

  // Find how many values are actually used
  const usedVals = new Set<number>();
  for (const b of edges) usedVals.add(b);
  let maxUsedVal = 0;
  for (const v of usedVals) if (v > maxUsedVal) maxUsedVal = v;
  const maxUsed = maxUsedVal + 1;
  console.log(`  Max used value: ${maxUsed - 1}, can fit ${256 - maxUsed} BPE merges in 1 byte`);

  for (const maxMerges of [16, 32, 48, 64, 96, 128, 192, 256, 512, 1024]) {
    // For merges that produce symbols > 255, we need 2-byte encoding
    const { symbols, mergeTable } = applyBPE16(edges, maxUsed, maxMerges);
    const actualMerges = mergeTable.length;

    // Check max symbol
    let maxSym = 0;
    for (const s of symbols) if (s > maxSym) maxSym = s;

    // Encode: if all symbols < 256, use 1 byte per symbol
    // Otherwise, use varint or 2-byte encoding
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(symbols.length & 0xff, (symbols.length >> 8) & 0xff, (symbols.length >> 16) & 0xff, (symbols.length >> 24) & 0xff);
    for (const c of comboOrder) buf.push(c);

    // Merge table: each entry is 2 varints
    buf.push(actualMerges & 0xff, (actualMerges >> 8) & 0xff);
    for (const [a, b] of mergeTable) {
      // Varint encode a and b
      let v = a;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
      v = b;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
    }

    // Symbols: if max < 256, 1 byte each. Otherwise varint.
    if (maxSym < 256) {
      buf.push(0); // 1-byte mode
      for (const s of symbols) buf.push(s);
    } else {
      buf.push(1); // varint mode
      for (const s of symbols) {
        let v = s;
        while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
        buf.push(v);
      }
    }

    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
    const marker = gz < baselineGz ? " <<<" : "";
    console.log(`  merges=${actualMerges.toString().padStart(4)}: data=${symbols.length}, maxSym=${maxSym}, gz=${gz} (${(gz/1024).toFixed(0)} KB)${marker}`);

    if (actualMerges <= 48 || actualMerges === 256 || actualMerges === 1024) {
      rows.push({ name: `BPE combo r22 m=${actualMerges}`, raw: buf.length, gz });
    }
  }
}

console.log("\n=== BPE on standard DFS (desc+upper5+r22) ===");
{
  const dfs = genStandardDFS(22, "desc", "upper5");
  const usedVals = new Set<number>();
  for (const b of dfs) usedVals.add(b);
  let maxUsedVal = 0;
  for (const v of usedVals) if (v > maxUsedVal) maxUsedVal = v;
  const maxUsed = maxUsedVal + 1;
  console.log(`  Max used value: ${maxUsed - 1}, can fit ${256 - maxUsed} BPE merges in 1 byte`);

  for (const maxMerges of [48, 96, 256, 512, 1024]) {
    const { symbols, mergeTable } = applyBPE16(dfs, maxUsed, maxMerges);
    const actualMerges = mergeTable.length;
    let maxSym = 0;
    for (const s of symbols) if (s > maxSym) maxSym = s;

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(symbols.length & 0xff, (symbols.length >> 8) & 0xff, (symbols.length >> 16) & 0xff, (symbols.length >> 24) & 0xff);
    buf.push(actualMerges & 0xff, (actualMerges >> 8) & 0xff);
    for (const [a, b] of mergeTable) {
      let v = a;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
      v = b;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
    }
    if (maxSym < 256) {
      buf.push(0);
      for (const s of symbols) buf.push(s);
    } else {
      buf.push(1);
      for (const s of symbols) {
        let v = s;
        while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
        buf.push(v);
      }
    }
    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
    const marker = gz < baselineGz ? " <<<" : "";
    console.log(`  merges=${actualMerges.toString().padStart(4)}: data=${symbols.length}, maxSym=${maxSym}, gz=${gz} (${(gz/1024).toFixed(0)} KB)${marker}`);
    rows.push({ name: `BPE std d+u5+r22 m=${actualMerges}`, raw: buf.length, gz });
  }
}

console.log("\n=== BPE on standard DFS (asc, lower5, rot=0) ===");
{
  const dfs = genStandardDFS(0, "asc", "lower5");
  const usedVals = new Set<number>();
  for (const b of dfs) usedVals.add(b);
  let maxUsedVal = 0;
  for (const v of usedVals) if (v > maxUsedVal) maxUsedVal = v;
  const maxUsed = maxUsedVal + 1;

  for (const maxMerges of [48, 96, 256, 512, 1024]) {
    const { symbols, mergeTable } = applyBPE16(dfs, maxUsed, maxMerges);
    const actualMerges = mergeTable.length;
    let maxSym = 0;
    for (const s of symbols) if (s > maxSym) maxSym = s;

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(symbols.length & 0xff, (symbols.length >> 8) & 0xff, (symbols.length >> 16) & 0xff, (symbols.length >> 24) & 0xff);
    buf.push(actualMerges & 0xff, (actualMerges >> 8) & 0xff);
    for (const [a, b] of mergeTable) {
      let v = a;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
      v = b;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
    }
    if (maxSym < 256) {
      buf.push(0);
      for (const s of symbols) buf.push(s);
    } else {
      buf.push(1);
      for (const s of symbols) {
        let v = s;
        while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
        buf.push(v);
      }
    }
    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
    const marker = gz < baselineGz ? " <<<" : "";
    console.log(`  merges=${actualMerges.toString().padStart(4)}: data=${symbols.length}, maxSym=${maxSym}, gz=${gz} (${(gz/1024).toFixed(0)} KB)${marker}`);
    rows.push({ name: `BPE std asc+l5+r0 m=${actualMerges}`, raw: buf.length, gz });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Try BPE directly on raw word list (front-coded)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== BPE on front-coded word list ===");
{
  // Generate front-coded data (share+26 marker)
  const fcBuf: number[] = [];
  let prev = "";
  for (const w of words) {
    let shared = 0;
    while (shared < prev.length && shared < w.length && prev[shared] === w[shared]) shared++;
    fcBuf.push(shared + 26);
    for (let i = shared; i < w.length; i++) fcBuf.push(w.charCodeAt(i) - 97);
    prev = w;
  }

  const fcData = new Uint8Array(fcBuf);
  const usedVals = new Set<number>();
  for (const b of fcData) usedVals.add(b);
  let maxUsedVal = 0;
  for (const v of usedVals) if (v > maxUsedVal) maxUsedVal = v;
  const maxUsed = maxUsedVal + 1;
  console.log(`  Front-coded: ${fcData.length} bytes, maxUsed=${maxUsed - 1}`);

  for (const maxMerges of [48, 128, 256, 512, 1024, 2048]) {
    const { symbols, mergeTable } = applyBPE16(fcData, maxUsed, maxMerges);
    const actualMerges = mergeTable.length;
    let maxSym = 0;
    for (const s of symbols) if (s > maxSym) maxSym = s;

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(symbols.length & 0xff, (symbols.length >> 8) & 0xff, (symbols.length >> 16) & 0xff, (symbols.length >> 24) & 0xff);
    buf.push(actualMerges & 0xff, (actualMerges >> 8) & 0xff);
    for (const [a, b] of mergeTable) {
      let v = a;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
      v = b;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
    }
    if (maxSym < 256) {
      buf.push(0);
      for (const s of symbols) buf.push(s);
    } else {
      buf.push(1);
      for (const s of symbols) {
        let v = s;
        while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
        buf.push(v);
      }
    }
    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
    const marker = gz < baselineGz ? " <<<" : "";
    console.log(`  merges=${actualMerges.toString().padStart(4)}: data=${symbols.length}, maxSym=${maxSym}, gz=${gz} (${(gz/1024).toFixed(0)} KB)${marker}`);
    if (actualMerges <= 48 || actualMerges === 256 || actualMerges >= 1024) {
      rows.push({ name: `BPE front-coded m=${actualMerges}`, raw: buf.length, gz });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// BPE on raw text (newline-separated)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== BPE on raw word list (a-z + newline) ===");
{
  const rawText = new TextEncoder().encode(words.join("\n"));
  console.log(`  Raw text: ${rawText.length} bytes`);

  // Use 27 base symbols (a-z + newline)
  // But raw bytes use ASCII values, remap to 0-26
  const mapped = new Uint8Array(rawText.length);
  for (let i = 0; i < rawText.length; i++) {
    if (rawText[i] === 10) mapped[i] = 26; // newline
    else mapped[i] = rawText[i] - 97; // a-z -> 0-25
  }

  for (const maxMerges of [128, 229, 256, 512, 1024, 2048, 4096]) {
    const { symbols, mergeTable } = applyBPE16(mapped, 27, maxMerges);
    const actualMerges = mergeTable.length;
    let maxSym = 0;
    for (const s of symbols) if (s > maxSym) maxSym = s;

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(symbols.length & 0xff, (symbols.length >> 8) & 0xff, (symbols.length >> 16) & 0xff, (symbols.length >> 24) & 0xff);
    buf.push(actualMerges & 0xff, (actualMerges >> 8) & 0xff);
    for (const [a, b] of mergeTable) {
      let v = a;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
      v = b;
      while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
      buf.push(v);
    }
    if (maxSym < 256) {
      buf.push(0);
      for (const s of symbols) buf.push(s);
    } else {
      buf.push(1);
      for (const s of symbols) {
        let v = s;
        while (v >= 0x80) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
        buf.push(v);
      }
    }
    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
    const marker = gz < baselineGz ? " <<<" : "";
    console.log(`  merges=${actualMerges.toString().padStart(4)}: data=${symbols.length}, maxSym=${maxSym}, gz=${gz} (${(gz/1024).toFixed(0)} KB)${marker}`);
    rows.push({ name: `BPE raw text m=${actualMerges}`, raw: buf.length, gz });
  }
}

// Final table
console.log("\n" + "=".repeat(80));
console.log("                        BPE OPTIMIZATION TABLE");
console.log("=".repeat(80));
console.log("");

console.log(
  "  " +
  "Approach".padEnd(44) +
  "Raw KB".padStart(8) +
  "  GZ KB".padStart(8) +
  "  GZ bytes".padStart(10) +
  "  vs base".padStart(10)
);
console.log("  " + "-".repeat(80));

rows.sort((a, b) => a.gz - b.gz);
for (const r of rows) {
  const rawKB = (r.raw / 1024).toFixed(0);
  const gzKB = (r.gz / 1024).toFixed(0);
  const marker = r.gz < baselineGz ? " <<<" : "";
  console.log(
    "  " +
    r.name.padEnd(44).slice(0, 44) +
    rawKB.padStart(8) +
    gzKB.padStart(8) +
    r.gz.toString().padStart(10) +
    ((r.gz / baselineGz * 100).toFixed(1) + "%").padStart(10) +
    marker
  );
}

console.log(`\n${"=".repeat(80)}`);
const best = rows[0];
console.log(`\nBEST: ${best.name}`);
console.log(`  Raw: ${(best.raw / 1024).toFixed(0)} KB, Gzipped: ${best.gz} bytes (${(best.gz/1024).toFixed(0)} KB)`);
console.log(`  vs baseline (603032): ${baselineGz - best.gz} bytes saved (${((1 - best.gz/baselineGz)*100).toFixed(2)}%)`);
