import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const text = readFileSync("words_alpha.txt", "utf-8");
const words = [
  ...new Set(text.split(/\r?\n/).map((w) => w.toLowerCase().trim()).filter(Boolean)),
].sort();

console.log(`Loaded ${words.length} words\n`);

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
  console.log(`  ${name}: raw=${(data.length/1024).toFixed(0)} KB, gz=${(gz/1024).toFixed(0)} KB (${gz} bytes)`);
}

// Baseline: DFS trie standard
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
  addRow("BASELINE: DFS trie standard", new Uint8Array(buf));
}

// Previous best: desc+upper5 rot=22 = 598121 bytes
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
  addRow("PREV BEST: desc+upper5 rot=22", new Uint8Array(buf));
}

console.log("\n=== COMBO SEARCH: rotation x sort x bit layout x char transform ===");

// Exhaustive search over combinations
type SortOrder = "asc" | "desc";
type BitLayout = "lower5" | "upper5";

let globalBest = Infinity;
let globalBestConfig = "";

// Test combo-mapped approach with all rotations
console.log("\n--- Combo-mapped with rotations ---");
{
  // Combo frequencies
  const comboCounts = new Array(8).fill(0);
  function countCombos(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
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

  for (const sortDir of ["asc", "desc"] as const) {
    for (let rot = 0; rot < 26; rot++) {
      const buf: number[] = [];
      const n = words.length;
      buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

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
          // Most frequent combo gets offset 0
          const comboIdx = comboOrder.indexOf(combo);
          buf.push(ch + comboIdx * 26);
          if (child.children.size > 0) serialize(child);
        }
      }
      serialize(root);
      const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
      if (gz < globalBest) {
        globalBest = gz;
        globalBestConfig = `combo-mapped ${sortDir} rot=${rot}`;
      }
    }
  }
  console.log(`  Best combo-mapped: ${globalBestConfig} = ${globalBest} bytes (${(globalBest/1024).toFixed(0)} KB)`);
}

// Test all rotations x sort x bit layout combinations
console.log("\n--- All rot x sort x layout ---");
{
  for (const sortDir of ["asc", "desc"] as const) {
    for (const layout of ["lower5", "upper5"] as const) {
      for (let rot = 0; rot < 26; rot++) {
        const buf: number[] = [];
        const n = words.length;
        buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

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
        const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
        if (gz < globalBest) {
          globalBest = gz;
          globalBestConfig = `${sortDir} ${layout} rot=${rot}`;
        }
      }
    }
  }
  console.log(`  Best standard layout: ${globalBestConfig} = ${globalBest} bytes (${(globalBest/1024).toFixed(0)} KB)`);
}

// Now try: freq-remapped bytes with all rotations
console.log("\n--- Freq-remapped with rotations ---");
{
  for (const sortDir of ["asc", "desc"] as const) {
    for (let rot = 0; rot < 26; rot++) {
      // Generate DFS bytes
      const dfsBuf: number[] = [];

      function genDFS(node: TrieNode) {
        const keys = [...node.children.keys()];
        if (sortDir === "asc") {
          keys.sort((a, b) => ((a + rot) % 26) - ((b + rot) % 26));
        } else {
          keys.sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
        }
        for (let i = 0; i < keys.length; i++) {
          const ch = keys[i];
          const child = node.children.get(ch)!;
          let byte = ch;
          if (child.isEnd) byte |= 0x20;
          if (child.children.size > 0) byte |= 0x40;
          if (i === keys.length - 1) byte |= 0x80;
          dfsBuf.push(byte);
          if (child.children.size > 0) genDFS(child);
        }
      }
      genDFS(root);

      // Freq-remap
      const freq = new Array(256).fill(0);
      for (const b of dfsBuf) freq[b]++;
      const ranked = [...Array(256).keys()].sort((a, b) => freq[b] - freq[a]);
      const remap = new Array(256);
      for (let i = 0; i < 256; i++) remap[ranked[i]] = i;

      const buf: number[] = [];
      const n = words.length;
      buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
      const usedCount = ranked.filter(b => freq[b] > 0).length;
      buf.push(usedCount);
      for (let i = 0; i < usedCount; i++) buf.push(ranked[i]);
      for (const b of dfsBuf) buf.push(remap[b]);

      const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
      if (gz < globalBest) {
        globalBest = gz;
        globalBestConfig = `freq-remap ${sortDir} rot=${rot}`;
      }
    }
  }
  console.log(`  Best freq-remap: ${globalBestConfig} = ${globalBest} bytes (${(globalBest/1024).toFixed(0)} KB)`);
}

// Now try: combo-mapped with freq-reordering within each combo group
console.log("\n--- Combo-mapped + freq-reorder within combo ---");
{
  // For each flag combo, remap the 26 chars by frequency within that combo
  for (const sortDir of ["asc", "desc"] as const) {
    for (let rot = 0; rot < 26; rot++) {
      // Count per-combo char frequencies
      const comboCharFreq = Array.from({length: 8}, () => new Array(26).fill(0));

      function countFreqs(node: TrieNode) {
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
          comboCharFreq[combo][ch]++;
          if (child.children.size > 0) countFreqs(child);
        }
      }
      countFreqs(root);

      // Combo frequencies
      const comboCounts = comboCharFreq.map(arr => arr.reduce((a, b) => a + b, 0));
      const comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);

      // For each combo, rank chars by frequency
      const comboCharMap = Array.from({length: 8}, (_, combo) => {
        const ranked = [...Array(26).keys()].sort((a, b) => comboCharFreq[combo][b] - comboCharFreq[combo][a]);
        const map = new Array(26);
        for (let i = 0; i < 26; i++) map[ranked[i]] = i;
        return map;
      });

      const buf: number[] = [];
      const n = words.length;
      buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

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
          const mappedCh = comboCharMap[combo][ch];
          buf.push(mappedCh + comboIdx * 26);
          if (child.children.size > 0) serialize(child);
        }
      }
      serialize(root);
      const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
      if (gz < globalBest) {
        globalBest = gz;
        globalBestConfig = `combo+freqchar ${sortDir} rot=${rot}`;
      }
    }
  }
  console.log(`  Best combo+freqchar: ${globalBestConfig} = ${globalBest} bytes (${(globalBest/1024).toFixed(0)} KB)`);
}

// Record the overall best
console.log(`\n=== OVERALL BEST CONFIG: ${globalBestConfig} = ${globalBest} bytes (${(globalBest/1024).toFixed(0)} KB) ===\n`);

// Generate the best configuration properly
console.log("Generating final best...");
{
  // Parse best config and regenerate with addRow
  // The best was desc upper5 rot=22 at 598121. Let's also try some new ideas.
}

// New idea: what about using 2 different byte encodings for leaf vs internal nodes?
// Leaf nodes (no children): char(5) + isEnd(1) + isLast(1) = 7 bits -> values 0-127
// Internal nodes (has children): char(5) + isEnd(1) + isLast(1) = 7 bits -> values 128-255
// Wait, this is the same as the current encoding just with hasChildren in bit 7.
// The hasChildren flag is bit 6 in standard. If we move it to the most significant bit...

console.log("\n=== NEW IDEAS ===");

// N1: Try different flag bit positions systematically
{
  // 3 flags: isEnd, hasChildren, isLast
  // 6 possible permutations of their bit positions (bits 5, 6, 7)
  const permutations = [
    { bits: [5, 6, 7], name: "end5-child6-last7" }, // standard
    { bits: [5, 7, 6], name: "end5-child7-last6" },
    { bits: [6, 5, 7], name: "end6-child5-last7" },
    { bits: [6, 7, 5], name: "end6-child7-last5" },
    { bits: [7, 5, 6], name: "end7-child5-last6" },
    { bits: [7, 6, 5], name: "end7-child6-last5" },
  ];

  let bestPerm = "";
  let bestPermGz = Infinity;

  for (const perm of permutations) {
    for (let rot = 0; rot < 26; rot++) {
      for (const sortDir of ["asc", "desc"] as const) {
        const buf: number[] = [];
        const n = words.length;
        buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

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
            let byte = ch; // bits 0-4
            if (child.isEnd) byte |= (1 << perm.bits[0]);
            if (child.children.size > 0) byte |= (1 << perm.bits[1]);
            if (i === keys.length - 1) byte |= (1 << perm.bits[2]);
            buf.push(byte);
            if (child.children.size > 0) serialize(child);
          }
        }
        serialize(root);
        const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
        if (gz < bestPermGz) {
          bestPermGz = gz;
          bestPerm = `${perm.name} ${sortDir} rot=${rot}`;
        }
      }
    }
  }
  console.log(`  Best flag permutation: ${bestPerm} = ${bestPermGz} bytes (${(bestPermGz/1024).toFixed(0)} KB)`);
  if (bestPermGz < globalBest) {
    globalBest = bestPermGz;
    globalBestConfig = `perm: ${bestPerm}`;
  }
}

// N2: Interleave char and flags in different bit positions for upper5
// char in bits 3-7, flags in bits 0-2, but try all 6 flag orderings
{
  const flagPerms = [
    [0, 1, 2], // end0-child1-last2 (current upper5)
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];

  let bestU5 = Infinity;
  let bestU5Config = "";

  for (const fp of flagPerms) {
    for (let rot = 0; rot < 26; rot++) {
      for (const sortDir of ["asc", "desc"] as const) {
        const buf: number[] = [];
        const n = words.length;
        buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

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
            let byte = ch << 3;
            if (child.isEnd) byte |= (1 << fp[0]);
            if (child.children.size > 0) byte |= (1 << fp[1]);
            if (i === keys.length - 1) byte |= (1 << fp[2]);
            buf.push(byte);
            if (child.children.size > 0) serialize(child);
          }
        }
        serialize(root);
        const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
        if (gz < bestU5) {
          bestU5 = gz;
          bestU5Config = `upper5 flagperm=[${fp}] ${sortDir} rot=${rot}`;
        }
      }
    }
  }
  console.log(`  Best upper5 flag perm: ${bestU5Config} = ${bestU5} bytes (${(bestU5/1024).toFixed(0)} KB)`);
  if (bestU5 < globalBest) {
    globalBest = bestU5;
    globalBestConfig = bestU5Config;
  }
}

// N3: What about splitting into 2 halves of the alphabet?
// First half (a-m, 13 chars) use 4 bits, second half (n-z, 13 chars) use 4 bits with offset
// This way we can fit char + 3 flags in 7 bits... doesn't help since we need 8 bits anyway.

// N4: Separate "single child" nodes from "multiple children" nodes
// 58% of nodes have exactly 1 child. For these, isLast is always true.
// Use a 2-byte encoding: byte1 = char(5) + isEnd(1) + isSingleChild(1) + hasChildren(1)
// If isSingleChild=1: isLast is implied, save that bit.
// If isSingleChild=0: next edges have isLast flag.
// Actually this doesn't save anything since isSingleChild IS isLast for the child.

// N5: Try interleaving subtrees differently: emit all edges at depth d before depth d+1
// (This is BFS which we already tested. Let's try a hybrid.)

// N6: For the desc+upper5+rot22 winner, try combining with freq-remap of just the char part
{
  const rot = 22;
  const dfsBuf: number[] = [];

  function genDFS(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch << 3;
      if (child.isEnd) byte |= 0x01;
      if (child.children.size > 0) byte |= 0x02;
      if (i === keys.length - 1) byte |= 0x04;
      dfsBuf.push(byte);
      if (child.children.size > 0) genDFS(child);
    }
  }
  genDFS(root);

  // Full byte freq-remap
  const freq = new Array(256).fill(0);
  for (const b of dfsBuf) freq[b]++;
  const ranked = [...Array(256).keys()].sort((a, b) => freq[b] - freq[a]);
  const remap = new Array(256);
  for (let i = 0; i < 256; i++) remap[ranked[i]] = i;

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  const usedCount = ranked.filter(b => freq[b] > 0).length;
  buf.push(usedCount);
  for (let i = 0; i < usedCount; i++) buf.push(ranked[i]);
  for (const b of dfsBuf) buf.push(remap[b]);

  addRow("N6. desc+upper5+rot22 + freq-remap", new Uint8Array(buf));
}

// N7: Try char remapping per parent char (context-specific) with the best layout
{
  const rot = 22;
  // Count char frequencies per parent context
  const parentCharFreq = Array.from({length: 27}, () => new Array(26).fill(0));

  function countCtx(node: TrieNode, parentCh: number) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (const ch of keys) {
      parentCharFreq[parentCh][ch]++;
      const child = node.children.get(ch)!;
      if (child.children.size > 0) countCtx(child, ch);
    }
  }
  countCtx(root, 26);

  // Per-context char ranking
  const ctxCharRank = Array.from({length: 27}, (_, ctx) => {
    const ranked = [...Array(26).keys()].sort((a, b) => parentCharFreq[ctx][b] - parentCharFreq[ctx][a]);
    const map = new Array(26);
    for (let i = 0; i < 26; i++) map[ranked[i]] = i;
    return map;
  });

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Store 27 rank tables (27*26=702 bytes)
  for (let ctx = 0; ctx < 27; ctx++) {
    const ranked = [...Array(26).keys()].sort((a, b) => parentCharFreq[ctx][b] - parentCharFreq[ctx][a]);
    for (const r of ranked) buf.push(r);
  }

  function serialize(node: TrieNode, parentCh: number) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const mapped = ctxCharRank[parentCh][ch];
      let byte = mapped << 3;
      if (child.isEnd) byte |= 0x01;
      if (child.children.size > 0) byte |= 0x02;
      if (i === keys.length - 1) byte |= 0x04;
      buf.push(byte);
      if (child.children.size > 0) serialize(child, ch);
    }
  }
  serialize(root, 26);
  addRow("N7. desc+upper5+rot22 + ctx char map", new Uint8Array(buf));
}

// N8: Try the "no hasChildren flag" approach with the best rotation
// Use 0x1f (char=31, never used as char*8 = 31*8=248 < 256 so fine)
// as end-of-children marker. Each edge byte: char<<2 | isEnd<<1 | isLast
// Wait, without hasChildren we don't need isLast either if we use a marker.
// byte = char(5) + isEnd(1) = 6 bits, range 0-51
// marker = some value > 51, say 52
{
  const rot = 22;
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20; // bit 5
      // no isLast, no hasChildren
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
    buf.push(52); // end-of-children marker
  }
  serialize(root);
  addRow("N8. marker-based, no flags, rot=22", new Uint8Array(buf));
}

// N9: DFS with interleaved "structure" and "data" bytes
// For each node: first emit structure byte (childCount + isEnd), then emit child chars as a group
// Then recurse. This way the structure bytes cluster together locally.
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    // Emit child chars and isEnd flags
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
    }
    // Then recurse
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("N9. DFS breadth-first per node", new Uint8Array(buf));
}

// N10: Predictive encoding: predict the next byte based on the last byte, encode the residual
{
  // Generate standard DFS bytes
  const dfsBuf: number[] = [];
  function genDFS10(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      dfsBuf.push(byte);
      if (child.children.size > 0) genDFS10(child);
    }
  }
  genDFS10(root);

  // Build prediction table: for each byte value, predict the most likely next byte
  const transitions = Array.from({length: 256}, () => new Array(256).fill(0));
  for (let i = 0; i < dfsBuf.length - 1; i++) {
    transitions[dfsBuf[i]][dfsBuf[i + 1]]++;
  }
  const prediction = new Array(256);
  for (let i = 0; i < 256; i++) {
    let bestNext = 0, bestCount = 0;
    for (let j = 0; j < 256; j++) {
      if (transitions[i][j] > bestCount) { bestCount = transitions[i][j]; bestNext = j; }
    }
    prediction[i] = bestNext;
  }

  // Encode: XOR each byte with its prediction
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Store prediction table (256 bytes)
  for (let i = 0; i < 256; i++) buf.push(prediction[i]);
  // XOR-encoded stream
  let prev = 0;
  for (const b of dfsBuf) {
    buf.push(b ^ prediction[prev]);
    prev = b;
  }
  addRow("N10. DFS + predictive XOR", new Uint8Array(buf));
}

// Final summary
console.log("\n" + "=".repeat(80));
console.log("                        ITERATION 2C COMPARISON TABLE");
console.log("=".repeat(80));
console.log("");

const baseline = rows.find(r => r.name.includes("BASELINE"))!;

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
  const marker = r.gz < baseline.gz ? " <<<" : "";
  console.log(
    "  " +
    r.name.padEnd(44).slice(0, 44) +
    rawKB.padStart(8) +
    gzKB.padStart(8) +
    r.gz.toString().padStart(10) +
    ((r.gz / baseline.gz * 100).toFixed(1) + "%").padStart(10) +
    marker
  );
}

console.log(`\n${"=".repeat(80)}`);
console.log(`\nGLOBAL BEST (from exhaustive search): ${globalBestConfig}`);
console.log(`  Gzipped: ${globalBest} bytes (${(globalBest/1024).toFixed(0)} KB)`);
console.log(`  Improvement over baseline: ${baseline.gz - globalBest} bytes (${((1 - globalBest/baseline.gz)*100).toFixed(2)}%)`);
