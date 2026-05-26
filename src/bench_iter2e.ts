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
  console.log(`  ${name}: gz=${gz} bytes (${(gz/1024).toFixed(0)} KB)`);
}

// Baselines
console.log("=== BASELINES ===");
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
  addRow("BASELINE: DFS standard (589 KB)", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// Generate the combo+remap best (596819 bytes) for reference
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== Generate combo+remap desc rot=22 ===");
{
  const rot = 22;
  // Compute combo order by frequency
  const comboCounts = new Array(8).fill(0);
  function countCombos(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      comboCounts[combo]++;
      if (child.children.size > 0) countCombos(child);
    }
  }
  countCombos(root);

  const comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);

  const dfsBytes: number[] = [];
  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      const comboIdx = comboOrder.indexOf(combo);
      dfsBytes.push(ch + comboIdx * 26);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);

  // Freq-remap
  const freq = new Array(256).fill(0);
  for (const b of dfsBytes) freq[b]++;
  const ranked = [...Array(256).keys()].sort((a, b) => freq[b] - freq[a]);
  const remap = new Array(256);
  for (let i = 0; i < 256; i++) remap[ranked[i]] = i;
  const usedCount = ranked.filter(b => freq[b] > 0).length;

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  buf.push(usedCount);
  for (let i = 0; i < usedCount; i++) buf.push(ranked[i]);
  for (const b of dfsBytes) buf.push(remap[b]);

  addRow("PREV BEST: combo+remap desc r22", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH A: Try removing the remap table overhead
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== A. No remap, just combo-mapped ===");
{
  const rot = 22;
  const comboCounts = new Array(8).fill(0);
  function countCombos(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const child = node.children.get(keys[i])!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      comboCounts[combo]++;
      if (child.children.size > 0) countCombos(child);
    }
  }
  countCombos(root);
  const comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Store combo order (8 bytes header)
  for (const c of comboOrder) buf.push(c);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      const comboIdx = comboOrder.indexOf(combo);
      buf.push(ch + comboIdx * 26);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("A1. combo-mapped desc r22 (no remap)", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH B: Exhaustive all rotations for combo-mapped (no remap)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== B. Exhaustive combo-mapped search (no remap) ===");
{
  let bestGz = Infinity;
  let bestConfig = "";

  for (const sortDir of ["asc", "desc"] as const) {
    for (let rot = 0; rot < 26; rot++) {
      const comboCounts = new Array(8).fill(0);
      function countCombos(node: TrieNode) {
        const keys = [...node.children.keys()];
        if (sortDir === "asc") {
          keys.sort((a, b) => ((a + rot) % 26) - ((b + rot) % 26));
        } else {
          keys.sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
        }
        for (let i = 0; i < keys.length; i++) {
          const child = node.children.get(keys[i])!;
          let combo = 0;
          if (child.isEnd) combo |= 1;
          if (child.children.size > 0) combo |= 2;
          if (i === keys.length - 1) combo |= 4;
          comboCounts[combo]++;
          if (child.children.size > 0) countCombos(child);
        }
      }
      countCombos(root);
      const comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);

      const buf: number[] = [];
      const n = words.length;
      buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
      for (const c of comboOrder) buf.push(c);

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
          let combo = 0;
          if (child.isEnd) combo |= 1;
          if (child.children.size > 0) combo |= 2;
          if (i === keys.length - 1) combo |= 4;
          const comboIdx = comboOrder.indexOf(combo);
          buf.push(ch + comboIdx * 26);
          if (child.children.size > 0) serialize(child);
        }
      }
      serialize(root);
      const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
      if (gz < bestGz) {
        bestGz = gz;
        bestConfig = `${sortDir} rot=${rot}`;
      }
    }
  }
  console.log(`  Best combo-mapped (no remap): ${bestConfig} = ${bestGz} bytes (${(bestGz/1024).toFixed(0)} KB)`);
  rows.push({ name: `B. combo-mapped: ${bestConfig}`, raw: 0, gz: bestGz });
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH C: Try different combo orderings (not just by frequency)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== C. Different combo orderings ===");
{
  const rot = 22;

  // What if we order combos by structural similarity rather than frequency?
  // E.g., group combos that share hasChildren together
  const orderings = [
    { name: "by_freq", order: null as number[] | null }, // computed per config
    { name: "hc_first", order: [6, 7, 2, 3, 5, 4, 1, 0] }, // hasChildren combos first
    { name: "hc_last", order: [5, 4, 1, 0, 6, 7, 2, 3] }, // hasChildren combos last
    { name: "end_group", order: [5, 7, 1, 3, 4, 6, 0, 2] }, // isEnd group together
    { name: "natural", order: [0, 1, 2, 3, 4, 5, 6, 7] }, // natural order
    { name: "reverse", order: [7, 6, 5, 4, 3, 2, 1, 0] },
  ];

  let bestOrd = "";
  let bestOrdGz = Infinity;

  for (const { name, order } of orderings) {
    let comboOrder: number[];
    if (order === null) {
      // Compute by frequency
      const comboCounts = new Array(8).fill(0);
      function countCombos(node: TrieNode) {
        const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
        for (let i = 0; i < keys.length; i++) {
          const child = node.children.get(keys[i])!;
          let combo = 0;
          if (child.isEnd) combo |= 1;
          if (child.children.size > 0) combo |= 2;
          if (i === keys.length - 1) combo |= 4;
          comboCounts[combo]++;
          if (child.children.size > 0) countCombos(child);
        }
      }
      countCombos(root);
      comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);
    } else {
      comboOrder = order;
    }

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    for (const c of comboOrder) buf.push(c);

    function serialize(node: TrieNode) {
      const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const child = node.children.get(ch)!;
        let combo = 0;
        if (child.isEnd) combo |= 1;
        if (child.children.size > 0) combo |= 2;
        if (i === keys.length - 1) combo |= 4;
        const comboIdx = comboOrder.indexOf(combo);
        buf.push(ch + comboIdx * 26);
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(root);
    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
    console.log(`  ${name}: ${gz} bytes`);
    if (gz < bestOrdGz) { bestOrdGz = gz; bestOrd = name; }
  }
  console.log(`  Best ordering: ${bestOrd} = ${bestOrdGz} bytes`);
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH D: Pure value 0-207 space (8 combos * 26 chars)
// Try all 8! = 40320 permutations of combo ordering
// Actually that's too many. Let's use smart search.
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== D. Smart combo permutation search ===");
{
  const rot = 22;

  // Collect DFS edges with their (combo, char) info
  interface Edge { combo: number; ch: number; }
  const edges: Edge[] = [];

  function collectEdges(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      edges.push({ combo, ch });
      if (child.children.size > 0) collectEdges(child);
    }
  }
  collectEdges(root);

  // For each combo permutation, we just need to remap combo -> index
  // and compute ch + index * 26. We can evaluate all 8! = 40320 permutations
  // since gzip is the bottleneck.

  // Actually, let's try all 40320 permutations. Each takes ~0.5s for gzip.
  // That's 20K seconds = way too long. Let's use greedy hill-climbing instead.

  // Start from freq-based ordering, try swaps
  const comboCounts = new Array(8).fill(0);
  for (const e of edges) comboCounts[e.combo]++;
  let bestOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);

  function evalOrder(order: number[]): number {
    const comboToIdx = new Array(8);
    for (let i = 0; i < 8; i++) comboToIdx[order[i]] = i;

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    for (const c of order) buf.push(c);
    for (const e of edges) buf.push(e.ch + comboToIdx[e.combo] * 26);
    return gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
  }

  let bestGz = evalOrder(bestOrder);
  console.log(`  Initial (freq-based): ${bestGz} bytes`);

  // Hill climb: try all pairwise swaps
  let improved = true;
  let iterations = 0;
  while (improved && iterations < 20) {
    improved = false;
    iterations++;
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const newOrder = [...bestOrder];
        [newOrder[i], newOrder[j]] = [newOrder[j], newOrder[i]];
        const gz = evalOrder(newOrder);
        if (gz < bestGz) {
          bestGz = gz;
          bestOrder = newOrder;
          improved = true;
        }
      }
    }
  }
  console.log(`  Hill-climbed: ${bestGz} bytes (${iterations} iterations)`);
  console.log(`  Best order: [${bestOrder}]`);

  // Record as a row
  {
    const comboToIdx = new Array(8);
    for (let i = 0; i < 8; i++) comboToIdx[bestOrder[i]] = i;
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    for (const c of bestOrder) buf.push(c);
    for (const e of edges) buf.push(e.ch + comboToIdx[e.combo] * 26);
    addRow("D. Hill-climbed combo order", new Uint8Array(buf));
  }

  // D2: Now try freq-remapping the hill-climbed result
  {
    const comboToIdx = new Array(8);
    for (let i = 0; i < 8; i++) comboToIdx[bestOrder[i]] = i;
    const dfsBytes: number[] = [];
    for (const e of edges) dfsBytes.push(e.ch + comboToIdx[e.combo] * 26);

    const freq = new Array(256).fill(0);
    for (const b of dfsBytes) freq[b]++;
    const ranked = [...Array(256).keys()].sort((a, b) => freq[b] - freq[a]);
    const remap = new Array(256);
    for (let i = 0; i < 256; i++) remap[ranked[i]] = i;
    const usedCount = ranked.filter(b => freq[b] > 0).length;

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(usedCount);
    for (let i = 0; i < usedCount; i++) buf.push(ranked[i]);
    for (const b of dfsBytes) buf.push(remap[b]);
    addRow("D2. Hill-climbed + freq-remap", new Uint8Array(buf));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH E: Try fundamentally different encoding
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== E. Radically different approaches ===");

// E1: 2-byte encoding for common patterns, 1-byte for rare ones
// Most common edge = "has children, is last, not end" (43.8% = combo 6)
// Second most = "end, no children, is last" (23.9% = combo 5)
// What if combo 6 edges are free (just the char), and others pay a flag byte?
{
  // This is essentially: if hasChild && isLast && !isEnd, emit just the char (0-25)
  // Otherwise, emit 26 + standard byte. Range: 0-25 for the common case, 26+ for others.
  // But gzip handles this fine anyway. Let's try.

  const rot = 22;
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const isEnd = child.isEnd;
      const hasChild = child.children.size > 0;
      const isLast = i === keys.length - 1;

      if (hasChild && isLast && !isEnd) {
        // Most common: just the char (0-25)
        buf.push(ch);
      } else if (!isEnd && !hasChild && isLast) {
        // Leaf, not word end, is last (combo 4) - should be 0 count!
        buf.push(ch + 26);
      } else if (isEnd && !hasChild && isLast) {
        // End, no children, is last (combo 5): 23.9%
        buf.push(ch + 52);
      } else if (!isEnd && hasChild && !isLast) {
        // Has children, not last (combo 2): 20.2%
        buf.push(ch + 78);
      } else if (isEnd && hasChild && isLast) {
        // End, has children, is last (combo 7): 4.9%
        buf.push(ch + 104);
      } else if (isEnd && hasChild && !isLast) {
        // End, has children, not last (combo 3): 3.7%
        buf.push(ch + 130);
      } else if (isEnd && !hasChild && !isLast) {
        // End, no children, not last (combo 1): 3.6%
        buf.push(ch + 156);
      } else {
        // combo 0 or 4: should be 0%
        buf.push(ch + 182);
      }
      if (hasChild) serialize(child);
    }
  }
  serialize(root);
  addRow("E1. Manual combo mapping desc r22", new Uint8Array(buf));
}

// E2: Run-length encoding of consecutive identical bytes
{
  const rot = 22;
  // Generate standard DFS
  const dfsBytes: number[] = [];
  function genDFS(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch << 3;
      if (child.isEnd) byte |= 0x01;
      if (child.children.size > 0) byte |= 0x02;
      if (i === keys.length - 1) byte |= 0x04;
      dfsBytes.push(byte);
      if (child.children.size > 0) genDFS(child);
    }
  }
  genDFS(root);

  // Count consecutive identical bytes
  let runs = 0;
  let maxRun = 0;
  let totalRunLen = 0;
  let prev = -1;
  let runLen = 0;
  for (const b of dfsBytes) {
    if (b === prev) {
      runLen++;
    } else {
      if (runLen > 1) { runs++; totalRunLen += runLen; maxRun = Math.max(maxRun, runLen); }
      prev = b;
      runLen = 1;
    }
  }
  if (runLen > 1) { runs++; totalRunLen += runLen; maxRun = Math.max(maxRun, runLen); }
  console.log(`  Identical-byte runs: ${runs}, max=${maxRun}, total=${totalRunLen}`);
}

// E3: Try 9-bit encoding: 8 combos * 26 chars = 208 values, pack in 8 bits directly
// But with the unused 48 values (208-255) reserved for special patterns
// Specifically: use values 208-255 to encode common 2-byte sequences
{
  const rot = 22;

  // Collect edges
  interface Edge { combo: number; ch: number; }
  const edges: Edge[] = [];
  function collectEdges(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      edges.push({ combo, ch });
      if (child.children.size > 0) collectEdges(child);
    }
  }
  collectEdges(root);

  // Combo order by frequency
  const comboCounts = new Array(8).fill(0);
  for (const e of edges) comboCounts[e.combo]++;
  const comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);
  const comboToIdx = new Array(8);
  for (let i = 0; i < 8; i++) comboToIdx[comboOrder[i]] = i;

  // Compute raw values
  const rawValues = edges.map(e => e.ch + comboToIdx[e.combo] * 26);

  // Find most common 2-byte pairs
  const pairCounts = new Map<number, number>();
  for (let i = 0; i < rawValues.length - 1; i++) {
    const pair = rawValues[i] * 256 + rawValues[i + 1]; // first * 256 + second
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }

  // Top 48 pairs (we have 48 spare byte values: 208-255)
  const topPairs = [...pairCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 48);
  const pairToCode = new Map<number, number>();
  for (let i = 0; i < topPairs.length; i++) {
    pairToCode.set(topPairs[i][0], 208 + i);
  }

  console.log(`  Top pair savings: ${topPairs.slice(0, 5).map(([p, c]) => `${p}:${c}`).join(", ")}`);

  // Encode with pair compression
  const encoded: number[] = [];
  let i = 0;
  while (i < rawValues.length) {
    if (i < rawValues.length - 1) {
      const pair = rawValues[i] * 256 + rawValues[i + 1];
      const code = pairToCode.get(pair);
      if (code !== undefined) {
        encoded.push(code);
        i += 2;
        continue;
      }
    }
    encoded.push(rawValues[i]);
    i++;
  }

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  buf.push(encoded.length & 0xff, (encoded.length >> 8) & 0xff, (encoded.length >> 16) & 0xff, (encoded.length >> 24) & 0xff);
  for (const c of comboOrder) buf.push(c);
  // Store pair table (48 * 2 bytes = 96 bytes)
  buf.push(topPairs.length);
  for (const [pair] of topPairs) {
    buf.push(pair >> 8, pair & 0xff); // first, second (both < 208)
  }
  for (const b of encoded) buf.push(b);

  addRow("E3. Pair-compressed combo-mapped", new Uint8Array(buf));

  // E3b: Same but with 128 pairs (values 128-255) -- halves the char values to 0-4 per combo
  // This only works if we have fewer combos. Actually: we use 6 non-zero combos * 26 = 156 values.
  // We can fit 100 pairs in 156-255 range.
}

// E4: Byte-pair encoding (BPE) applied iteratively
{
  const rot = 22;

  const edges2: { combo: number; ch: number }[] = [];
  function collectEdges2(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      edges2.push({ combo, ch });
      if (child.children.size > 0) collectEdges2(child);
    }
  }
  collectEdges2(root);

  const comboCounts2 = new Array(8).fill(0);
  for (const e of edges2) comboCounts2[e.combo]++;
  const comboOrder2 = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts2[b] - comboCounts2[a]);
  const comboToIdx2 = new Array(8);
  for (let i = 0; i < 8; i++) comboToIdx2[comboOrder2[i]] = i;

  // Start with values 0-207 (6 used combos * 26)
  let data = new Uint8Array(edges2.map(e => e.ch + comboToIdx2[e.combo] * 26));
  const usedVals = new Set<number>();
  for (const b of data) usedVals.add(b);
  let nextSymbol = 208; // next available symbol
  const mergeTable: Array<[number, number]> = [];

  // BPE iterations
  for (let iter = 0; iter < 48 && nextSymbol < 256; iter++) {
    // Count pairs
    const pairs = new Map<number, number>();
    for (let j = 0; j < data.length - 1; j++) {
      const key = data[j] * 256 + data[j + 1];
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }

    // Find most frequent pair
    let bestPair = 0, bestCount = 0;
    for (const [pair, count] of pairs) {
      if (count > bestCount) { bestCount = count; bestPair = pair; }
    }

    if (bestCount < 3) break; // no more useful merges

    const a = bestPair >> 8, b = bestPair & 0xff;
    mergeTable.push([a, b]);

    // Replace all occurrences
    const newData: number[] = [];
    let j = 0;
    while (j < data.length) {
      if (j < data.length - 1 && data[j] === a && data[j + 1] === b) {
        newData.push(nextSymbol);
        j += 2;
      } else {
        newData.push(data[j]);
        j++;
      }
    }
    data = new Uint8Array(newData);
    nextSymbol++;
  }

  console.log(`  BPE: ${mergeTable.length} merges, data size: ${data.length}`);

  // Encode
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  buf.push(data.length & 0xff, (data.length >> 8) & 0xff, (data.length >> 16) & 0xff, (data.length >> 24) & 0xff);
  for (const c of comboOrder2) buf.push(c);
  buf.push(mergeTable.length);
  for (const [a, b] of mergeTable) buf.push(a, b);
  for (const b of data) buf.push(b);

  addRow("E4. BPE on combo-mapped stream", new Uint8Array(buf));
}

// E5: "Column" encoding: split the trie by depth
// Encode each depth level separately, then concatenate
// At each depth, store just the char+flags for edges at that depth
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // Collect edges by depth in DFS order
  const depthEdges = new Map<number, number[]>();
  let maxDepth = 0;

  function collectByDepth(node: TrieNode, depth: number) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      let arr = depthEdges.get(depth);
      if (!arr) { arr = []; depthEdges.set(depth, arr); }
      arr.push(byte);
      if (child.children.size > 0) collectByDepth(child, depth + 1);
    }
    if (depth > maxDepth) maxDepth = depth;
  }
  collectByDepth(root, 0);

  buf.push(maxDepth + 1);
  // For each depth: write count then bytes
  for (let d = 0; d <= maxDepth; d++) {
    const arr = depthEdges.get(d) ?? [];
    buf.push(arr.length & 0xff, (arr.length >> 8) & 0xff, (arr.length >> 16) & 0xff, (arr.length >> 24) & 0xff);
    for (const b of arr) buf.push(b);
  }

  addRow("E5. Depth-column encoding", new Uint8Array(buf));
}

// Final table
console.log("\n" + "=".repeat(80));
console.log("                        ITERATION 2E FINAL TABLE");
console.log("=".repeat(80));
console.log("");

const baseRow = rows.find(r => r.name.includes("BASELINE"))!;

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
  const rawKB = r.raw > 0 ? (r.raw / 1024).toFixed(0) : "?";
  const gzKB = (r.gz / 1024).toFixed(0);
  const marker = r.gz < baseRow.gz ? " <<<" : "";
  console.log(
    "  " +
    r.name.padEnd(44).slice(0, 44) +
    rawKB.toString().padStart(8) +
    gzKB.padStart(8) +
    r.gz.toString().padStart(10) +
    ((r.gz / baseRow.gz * 100).toFixed(1) + "%").padStart(10) +
    marker
  );
}

console.log(`\n${"=".repeat(80)}`);
const best = rows[0];
console.log(`\nBEST: ${best.name}`);
console.log(`  Gzipped: ${best.gz} bytes (${(best.gz/1024).toFixed(0)} KB)`);
console.log(`  vs baseline (603032): ${baseRow.gz - best.gz} bytes saved (${((1 - best.gz/baseRow.gz)*100).toFixed(2)}%)`);
