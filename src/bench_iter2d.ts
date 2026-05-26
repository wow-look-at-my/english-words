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
  console.log(`  ${name}: gz=${gz} bytes (${(gz/1024).toFixed(0)} KB)`);
}

// Baselines
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
  const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
  baselineGz = gz;
  rows.push({ name: "BASELINE: DFS standard", raw: buf.length, gz });
  console.log(`  BASELINE: ${gz} bytes (${(gz/1024).toFixed(0)} KB)`);
}

// Helper: generate DFS bytes with config
function genDFS(config: { rot: number; sortDir: "asc" | "desc"; layout: "lower5" | "upper5" }): number[] {
  const buf: number[] = [];
  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()];
    if (config.sortDir === "asc") {
      keys.sort((a, b) => ((a + config.rot) % 26) - ((b + config.rot) % 26));
    } else {
      keys.sort((a, b) => ((b + config.rot) % 26) - ((a + config.rot) % 26));
    }
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte: number;
      if (config.layout === "lower5") {
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
  return buf;
}

// Helper: freq-remap a byte array
function freqRemap(dfsBuf: number[]): { header: number[]; remapped: number[] } {
  const freq = new Array(256).fill(0);
  for (const b of dfsBuf) freq[b]++;
  const ranked = [...Array(256).keys()].sort((a, b) => freq[b] - freq[a]);
  const remap = new Array(256);
  for (let i = 0; i < 256; i++) remap[ranked[i]] = i;
  const usedCount = ranked.filter(b => freq[b] > 0).length;
  const header = [usedCount];
  for (let i = 0; i < usedCount; i++) header.push(ranked[i]);
  return { header, remapped: dfsBuf.map(b => remap[b]) };
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 1: Combine desc+upper5+rot22+freq-remap (current best = 596868)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== Current best: desc+upper5+rot22+freq-remap ===");
{
  const dfs = genDFS({ rot: 22, sortDir: "desc", layout: "upper5" });
  const { header, remapped } = freqRemap(dfs);
  const n = words.length;
  const buf = [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, ...header, ...remapped];
  addRow("Current best (desc+u5+r22+remap)", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 2: Eliminate a flag by encoding differently
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 2. Eliminate hasChildren flag ===");

// Observation: isLast + hasChildren together determine the structure.
// What if we encode them as a single 2-bit field, and reduce char to 4 bits for common chars?
// Or: can we infer hasChildren from context?

// The idea: emit children in groups. For each node:
// - First, emit number of children (1-26, fits in 5 bits)
// - Then emit each child: char(5) + isEnd(1) = 6 bits
// No isLast or hasChildren needed! But costs 1 byte per node for child count.
// Nodes: 1,027,810. So adds 1MB. But child counts are very skewed (most are 1).
// Use varint: 1-byte for count 1-127 (covers all).

// Actually: nodes = 1,027,810 but only nodes with children emit a count.
// Leaf nodes don't emit anything. Internal nodes = ~580K. So ~580KB overhead.
// Total = 1027809 edges * 6/8 bytes (chars) + 580K bytes (counts) = ~1.35MB. Worse.

// Better: encode child count in unary. 1 child = "1", 2 children = "11", etc., terminated by "0".
// Average child count * 1 bit + 1 bit per node. Average branching ~1.8 -> ~2.8 bits per node.
// Total bits: ~1M * 2.8 = 2.8M bits = 350KB for structure.
// Plus char+isEnd: 1M * 6 bits = 750KB.
// Total: ~1100KB. Too big.

// Alternative: for single-child nodes (58%), don't emit any structure -- just the edge.
// Multi-child nodes get a child count. Signal "single child" via a flag bit.
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    if (keys.length === 1) {
      const ch = keys[0];
      const child = node.children.get(ch)!;
      // Single child: byte = char(5) + isEnd(1) + hasChildren(1) + singleChild=1(bit7)
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      byte |= 0x80; // single child marker
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    } else {
      // Multi-child: emit count, then each child byte
      buf.push(keys.length - 2); // 0 = 2 children, 1 = 3, etc. (max 24)
      for (const ch of keys) {
        const child = node.children.get(ch)!;
        let byte = ch;
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        // no isLast needed, count tells us
        buf.push(byte);
        if (child.children.size > 0) serialize(child);
      }
    }
  }
  serialize(root);
  addRow("2a. Single-child optimized", new Uint8Array(buf));
}

// 2b: Same but with freq-remap
{
  const innerBuf: number[] = [];

  function serialize2(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    if (keys.length === 1) {
      const ch = keys[0];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      byte |= 0x80;
      innerBuf.push(byte);
      if (child.children.size > 0) serialize2(child);
    } else {
      innerBuf.push(keys.length - 2);
      for (const ch of keys) {
        const child = node.children.get(ch)!;
        let byte = ch;
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        innerBuf.push(byte);
        if (child.children.size > 0) serialize2(child);
      }
    }
  }
  serialize2(root);

  const { header, remapped } = freqRemap(innerBuf);
  const n = words.length;
  const buf = [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, ...header, ...remapped];
  addRow("2b. Single-child optimized + remap", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 3: Exhaustive search over freq-remap + all configs
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 3. Exhaustive: remap + all configs ===");
{
  let bestGz = Infinity;
  let bestConfig = "";

  for (const sortDir of ["asc", "desc"] as const) {
    for (const layout of ["lower5", "upper5"] as const) {
      for (let rot = 0; rot < 26; rot++) {
        const dfs = genDFS({ rot, sortDir, layout });
        const { header, remapped } = freqRemap(dfs);
        const n = words.length;
        const buf = new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, ...header, ...remapped]);
        const gz = gzipSync(Buffer.from(buf), { level: 9 }).length;
        if (gz < bestGz) {
          bestGz = gz;
          bestConfig = `${sortDir} ${layout} rot=${rot}`;
        }
      }
    }
  }
  console.log(`  Best remap config: ${bestConfig} = ${bestGz} bytes (${(bestGz/1024).toFixed(0)} KB)`);
  rows.push({ name: `3. Best remap: ${bestConfig}`, raw: 0, gz: bestGz });

  // Also try combo-mapped + freq-remap within each combo
  console.log("  Testing combo-mapped + remap...");
  for (const sortDir of ["asc", "desc"] as const) {
    for (let rot = 0; rot < 26; rot++) {
      const comboCounts = new Array(8).fill(0);
      const comboCharCounts = Array.from({length: 8}, () => new Array(26).fill(0));

      function count(node: TrieNode) {
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
          comboCharCounts[combo][ch]++;
          if (child.children.size > 0) count(child);
        }
      }
      count(root);

      const comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);

      const dfsBytes: number[] = [];
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
          dfsBytes.push(ch + comboIdx * 26);
          if (child.children.size > 0) serialize(child);
        }
      }
      serialize(root);

      const { header, remapped } = freqRemap(dfsBytes);
      const n = words.length;
      const buf = new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, ...header, ...remapped]);
      const gz = gzipSync(Buffer.from(buf), { level: 9 }).length;
      if (gz < bestGz) {
        bestGz = gz;
        bestConfig = `combo+remap ${sortDir} rot=${rot}`;
      }
    }
  }
  console.log(`  Best combo+remap: ${bestConfig} = ${bestGz} bytes (${(bestGz/1024).toFixed(0)} KB)`);
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 4: Two different byte layouts for leaf vs internal edges
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 4. Leaf/internal split ===");
{
  // Leaf edges (no children): only need char(5) + isEnd(1) + isLast(1) = 7 bits
  // Internal edges (has children): need char(5) + isEnd(1) + isLast(1) = 7 bits too
  // The difference: leaf edges occupy bytes 0-127, internal edges 128-255
  // This is just moving hasChildren to bit 7. Already tested.
  // BUT: what if we split them into two separate streams?

  const leafStream: number[] = [];
  const internalStream: number[] = [];
  const typeStream: number[] = []; // 0=leaf, 1=internal (bitstream)

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const hasChild = child.children.size > 0;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (i === keys.length - 1) byte |= 0x40;
      typeStream.push(hasChild ? 1 : 0);
      if (hasChild) {
        internalStream.push(byte);
        serialize(child);
      } else {
        leafStream.push(byte);
      }
    }
  }
  serialize(root);

  // Pack type bitstream
  const typePacked = new Uint8Array(Math.ceil(typeStream.length / 8));
  for (let i = 0; i < typeStream.length; i++) {
    if (typeStream[i]) typePacked[i >> 3] |= (1 << (i & 7));
  }

  console.log(`  Leaf edges: ${leafStream.length}, Internal edges: ${internalStream.length}`);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(words.length, 0);
  header.writeUInt32LE(leafStream.length, 4);
  header.writeUInt32LE(internalStream.length, 8);
  const buf = Buffer.concat([header, typePacked, Buffer.from(leafStream), Buffer.from(internalStream)]);
  addRow("4a. Leaf/internal split streams", new Uint8Array(buf));

  // 4b: Same but freq-remap each stream independently
  const { header: lh, remapped: lr } = freqRemap(leafStream);
  const { header: ih, remapped: ir } = freqRemap(internalStream);
  const buf2 = Buffer.concat([
    header, typePacked,
    Buffer.from(new Uint8Array(lh)), Buffer.from(new Uint8Array(lr)),
    Buffer.from(new Uint8Array(ih)), Buffer.from(new Uint8Array(ir)),
  ]);
  addRow("4b. Leaf/internal split + remap", new Uint8Array(buf2));
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 5: Context-sensitive flag prediction
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 5. Context-sensitive encoding ===");

// 5a: For each byte, encode as (byte XOR most-common-byte-at-this-depth)
{
  // Collect bytes by depth
  const depthBytes = new Map<number, number[]>();
  function collectByDepth(node: TrieNode, depth: number) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      let arr = depthBytes.get(depth);
      if (!arr) { arr = []; depthBytes.set(depth, arr); }
      arr.push(byte);
      if (child.children.size > 0) collectByDepth(child, depth + 1);
    }
  }
  collectByDepth(root, 0);

  // For each depth, find the most common byte
  const depthMode = new Map<number, number>();
  for (const [d, bytes] of depthBytes) {
    const freq = new Array(256).fill(0);
    for (const b of bytes) freq[b]++;
    let best = 0, bestFreq = 0;
    for (let i = 0; i < 256; i++) if (freq[i] > bestFreq) { bestFreq = freq[i]; best = i; }
    depthMode.set(d, best);
  }

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Store mode per depth (max depth ~ 31, so 32 bytes)
  const maxDepth = Math.max(...depthBytes.keys());
  buf.push(maxDepth + 1);
  for (let d = 0; d <= maxDepth; d++) buf.push(depthMode.get(d) ?? 0);

  function serialize(node: TrieNode, depth: number) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      // XOR with depth mode
      buf.push(byte ^ (depthMode.get(depth) ?? 0));
      if (child.children.size > 0) serialize(child, depth + 1);
    }
  }
  serialize(root, 0);
  addRow("5a. DFS XOR depth-mode", new Uint8Array(buf));
}

// 5b: For each (parentChar, flagCombo), predict child char
// and encode the residual
{
  // This has too many contexts (27 * 8 = 216), too sparse. Skip.
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 6: Block-based encoding
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 6. Block-based ===");
{
  // Split the DFS byte stream into blocks of various sizes.
  // Within each block, separate chars and flags.
  // This is a middle ground between full interleaving and full separation.

  const dfs = genDFS({ rot: 22, sortDir: "desc", layout: "upper5" });

  for (const blockSize of [32, 64, 128, 256, 512, 1024, 4096]) {
    const parts: number[] = [];
    const n = words.length;
    parts.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    parts.push(dfs.length & 0xff, (dfs.length >> 8) & 0xff, (dfs.length >> 16) & 0xff, (dfs.length >> 24) & 0xff);

    for (let i = 0; i < dfs.length; i += blockSize) {
      const end = Math.min(i + blockSize, dfs.length);
      // Chars (upper 5 bits)
      for (let j = i; j < end; j++) parts.push(dfs[j] >> 3);
      // Flags (lower 3 bits)
      for (let j = i; j < end; j++) parts.push(dfs[j] & 7);
    }

    const gz = gzipSync(Buffer.from(new Uint8Array(parts)), { level: 9 }).length;
    if (gz < baselineGz) {
      rows.push({ name: `6. Block split bs=${blockSize}`, raw: parts.length, gz });
      console.log(`  Block bs=${blockSize}: gz=${gz} bytes (${(gz/1024).toFixed(0)} KB) <<<`);
    } else {
      console.log(`  Block bs=${blockSize}: gz=${gz} bytes (${(gz/1024).toFixed(0)} KB)`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 7: Different char encoding per flag combo
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 7. Per-combo char mapping ===");
{
  // For each of the 8 flag combos, chars have different frequency distributions.
  // Map the 8*26 = 208 distinct (combo, char) pairs to 208 byte values,
  // ordered by global frequency. This way the Huffman coding in gzip is optimal.

  const rot = 22;
  const sortDir = "desc" as const;

  // Collect (combo, char) frequency
  const pairFreq = new Map<number, number>();

  function countPairs(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      const pairId = combo * 26 + ch;
      pairFreq.set(pairId, (pairFreq.get(pairId) ?? 0) + 1);
    }
    for (const ch of [...node.children.keys()]) {
      if (node.children.get(ch)!.children.size > 0) countPairs(node.children.get(ch)!);
    }
  }
  countPairs(root);

  // Sort pairs by frequency
  const allPairs = [...pairFreq.entries()].sort((a, b) => b[1] - a[1]);
  const pairRemap = new Map<number, number>();
  for (let i = 0; i < allPairs.length; i++) {
    pairRemap.set(allPairs[i][0], i);
  }

  console.log(`  Distinct (combo, char) pairs: ${allPairs.length}`);

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
      dfsBytes.push(pairRemap.get(combo * 26 + ch)!);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Store remap table
  buf.push(allPairs.length);
  for (const [pairId] of allPairs) {
    buf.push(pairId); // pairId fits in a byte (max 207)
  }
  for (const b of dfsBytes) buf.push(b);

  addRow("7. Per-combo char map (desc r22)", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 8: Compact DAWG with better serialization
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 8. Improved DAWG ===");
{
  // Build DAWG
  const sigs = new Map<TrieNode, string>();
  function sig(node: TrieNode): string {
    let cached = sigs.get(node);
    if (cached) return cached;
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    const s = (node.isEnd ? "1" : "0") + "[" + keys.map(ch => `${ch}:${sig(node.children.get(ch)!)}`).join(",") + "]";
    sigs.set(node, s);
    return s;
  }

  const sigToCanon = new Map<string, TrieNode>();
  function buildCanons(node: TrieNode) {
    const s = sig(node);
    if (!sigToCanon.has(s)) {
      sigToCanon.set(s, node);
      for (const child of node.children.values()) buildCanons(child);
    }
  }
  buildCanons(root);

  const uniqueNodes = sigToCanon.size;
  console.log(`  DAWG unique nodes: ${uniqueNodes}`);

  // Count how many times each unique subtree is referenced
  const refCount = new Map<string, number>();
  function countRefs(node: TrieNode) {
    const s = sig(node);
    refCount.set(s, (refCount.get(s) ?? 0) + 1);
    const canon = sigToCanon.get(s)!;
    if (canon === node) { // only follow canonical nodes to avoid double-counting
      for (const child of node.children.values()) countRefs(child);
    }
  }
  // Actually we need to count ALL references, not just canonical ones
  const refCount2 = new Map<string, number>();
  function countAllRefs(node: TrieNode) {
    for (const child of node.children.values()) {
      const s = sig(child);
      refCount2.set(s, (refCount2.get(s) ?? 0) + 1);
      countAllRefs(child);
    }
  }
  countAllRefs(root);

  // How many nodes are referenced more than once?
  let multiRef = 0;
  let singleRef = 0;
  for (const [, count] of refCount2) {
    if (count > 1) multiRef++;
    else singleRef++;
  }
  console.log(`  Multi-referenced: ${multiRef}, Single-referenced: ${singleRef}`);
  console.log(`  Total unique: ${uniqueNodes}, Savings from dedup: ${1027810 - uniqueNodes}`);

  // 8a: DAWG with inline-first DFS, compact backrefs
  // Key insight: only nodes referenced >1 time need to be inlined and backreffed.
  // Single-reference nodes can be emitted inline without any overhead.
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    const inlined = new Set<string>();
    const sigOffset = new Map<string, number>(); // sig -> byte offset in stream
    const multiRefSigs = new Set<string>();
    for (const [s, count] of refCount2) {
      if (count > 1) multiRefSigs.add(s);
    }

    // Assign sequential IDs to multi-ref nodes (in DFS order)
    let nextBackrefId = 0;
    const sigToBackrefId = new Map<string, number>();

    function writeVarint(val: number) {
      while (val >= 0x80) {
        buf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      buf.push(val);
    }

    function serialize(node: TrieNode) {
      const s = sig(node);
      const canon = sigToCanon.get(s)!;

      if (inlined.has(s)) {
        // Backref: marker + varint ID
        buf.push(0x1f); // marker (char 31 never used)
        writeVarint(sigToBackrefId.get(s)!);
        return;
      }

      inlined.add(s);
      if (multiRefSigs.has(s)) {
        sigToBackrefId.set(s, nextBackrefId++);
      }

      const keys = [...canon.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const child = canon.children.get(ch)!;
        let byte = ch;
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
        buf.push(byte);
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(root);

    console.log(`  8a backrefs used: ${nextBackrefId}`);
    addRow("8a. DAWG inline+sequential backref", new Uint8Array(buf));
  }

  // 8b: Same with rot=22, desc, upper5
  {
    const rot = 22;
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    const inlined = new Set<string>();
    let nextBackrefId = 0;
    const sigToBackrefId = new Map<string, number>();
    const multiRefSigs = new Set<string>();
    for (const [s, count] of refCount2) {
      if (count > 1) multiRefSigs.add(s);
    }

    function writeVarint(val: number) {
      while (val >= 0x80) {
        buf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      buf.push(val);
    }

    function serialize(node: TrieNode) {
      const s = sig(node);
      const canon = sigToCanon.get(s)!;

      if (inlined.has(s)) {
        // Backref: use byte value that isn't valid edge byte
        // For upper5: max valid is 25<<3 | 7 = 207. Values 208-255 are free.
        buf.push(208); // marker
        writeVarint(sigToBackrefId.get(s)!);
        return;
      }

      inlined.add(s);
      if (multiRefSigs.has(s)) {
        sigToBackrefId.set(s, nextBackrefId++);
      }

      const keys = [...canon.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const child = canon.children.get(ch)!;
        let byte = ch << 3;
        if (child.isEnd) byte |= 0x01;
        if (child.children.size > 0) byte |= 0x02;
        if (i === keys.length - 1) byte |= 0x04;
        buf.push(byte);
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(root);
    addRow("8b. DAWG desc+u5+r22 + seq backref", new Uint8Array(buf));
  }

  // 8c: DAWG with freq-remap
  {
    const rot = 22;
    const innerBuf: number[] = [];

    const inlined = new Set<string>();
    let nextBackrefId = 0;
    const sigToBackrefId = new Map<string, number>();
    const multiRefSigs = new Set<string>();
    for (const [s, count] of refCount2) {
      if (count > 1) multiRefSigs.add(s);
    }

    function writeVarint(val: number) {
      while (val >= 0x80) {
        innerBuf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      innerBuf.push(val);
    }

    function serialize(node: TrieNode) {
      const s = sig(node);
      const canon = sigToCanon.get(s)!;

      if (inlined.has(s)) {
        innerBuf.push(208);
        writeVarint(sigToBackrefId.get(s)!);
        return;
      }

      inlined.add(s);
      if (multiRefSigs.has(s)) {
        sigToBackrefId.set(s, nextBackrefId++);
      }

      const keys = [...canon.children.keys()].sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const child = canon.children.get(ch)!;
        let byte = ch << 3;
        if (child.isEnd) byte |= 0x01;
        if (child.children.size > 0) byte |= 0x02;
        if (i === keys.length - 1) byte |= 0x04;
        innerBuf.push(byte);
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(root);

    const { header, remapped } = freqRemap(innerBuf);
    const n = words.length;
    const buf = [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff, ...header, ...remapped];
    addRow("8c. DAWG desc+u5+r22 + remap", new Uint8Array(buf));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 9: Prefix-free coding for leaf patterns
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 9. Suffix analysis ===");
{
  // Many words end with common suffixes (ing, tion, ness, etc.)
  // In the trie, these manifest as shared leaf paths.
  // What about encoding common suffix patterns specially?

  // Count suffix patterns (last N edges before end-of-word)
  const suffixCounts = new Map<string, number>();
  function collectSuffixes(node: TrieNode, path: number[]) {
    if (node.isEnd) {
      for (let len = 1; len <= Math.min(path.length, 6); len++) {
        const suffix = path.slice(path.length - len).join(",");
        suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
      }
    }
    for (const [ch, child] of node.children) {
      path.push(ch);
      collectSuffixes(child, path);
      path.pop();
    }
  }
  collectSuffixes(root, []);

  // Top suffixes
  const topSuffixes = [...suffixCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("  Top suffixes:");
  for (const [s, c] of topSuffixes) {
    const chars = s.split(",").map(x => String.fromCharCode(+x + 97)).join("");
    console.log(`    "${chars}": ${c} (${(c/words.length*100).toFixed(1)}%)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// APPROACH 10: Optimal variable-size encoding
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 10. Combine everything: DAWG + remap ===");
{
  // The DAWG with 160K nodes vs 1M trie nodes should give massive savings
  // if we can encode the backreferences cheaply enough.
  // Issue: the backref overhead (marker + varint) eats into savings.

  // Let's check: how much raw data is saved by DAWG?
  const sigs2 = new Map<TrieNode, string>();
  function sig2(node: TrieNode): string {
    let cached = sigs2.get(node);
    if (cached) return cached;
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    const s = (node.isEnd ? "1" : "0") + "[" + keys.map(ch => `${ch}:${sig2(node.children.get(ch)!)}`).join(",") + "]";
    sigs2.set(node, s);
    return s;
  }

  // Count edges in DAWG vs trie
  const sigToCanon2 = new Map<string, TrieNode>();
  function buildCanons2(node: TrieNode) {
    const s = sig2(node);
    if (!sigToCanon2.has(s)) {
      sigToCanon2.set(s, node);
      for (const child of node.children.values()) buildCanons2(child);
    }
  }
  buildCanons2(root);

  let dawgEdges = 0;
  for (const [, canon] of sigToCanon2) {
    dawgEdges += canon.children.size;
  }
  console.log(`  DAWG edges: ${dawgEdges} (vs trie: 1027809)`);

  // Count backref overhead
  const refCount3 = new Map<string, number>();
  function countAllRefs2(node: TrieNode) {
    for (const child of node.children.values()) {
      const s = sig2(child);
      refCount3.set(s, (refCount3.get(s) ?? 0) + 1);
      countAllRefs2(child);
    }
  }
  countAllRefs2(root);

  let totalBackrefs = 0;
  let totalBackrefBytes = 0;
  let nextId = 0;
  const multiRefSigs3 = new Set<string>();
  for (const [s, count] of refCount3) {
    if (count > 1) {
      multiRefSigs3.add(s);
      totalBackrefs += count - 1; // first is inline, rest are backrefs
      // Each backref: 1 marker + varint(id). ID starts at 0.
      const id = nextId++;
      let vidBytes = 1;
      let v = id;
      while (v >= 0x80) { vidBytes++; v >>= 7; }
      totalBackrefBytes += (count - 1) * (1 + vidBytes);
    }
  }
  console.log(`  Total backrefs: ${totalBackrefs}, backref overhead: ${totalBackrefBytes} bytes`);
  console.log(`  Edges saved: ${1027809 - dawgEdges - totalBackrefs}, Net edge bytes: ${dawgEdges + totalBackrefBytes}`);
}

// Final table
console.log("\n" + "=".repeat(80));
console.log("                        ITERATION 2D FINAL TABLE");
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
  const rawKB = (r.raw / 1024).toFixed(0);
  const gzKB = (r.gz / 1024).toFixed(0);
  const marker = r.gz < baseRow.gz ? " <<<" : "";
  console.log(
    "  " +
    r.name.padEnd(44).slice(0, 44) +
    rawKB.padStart(8) +
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
console.log(`  vs baseline: ${baseRow.gz - best.gz} bytes saved (${((1 - best.gz/baseRow.gz)*100).toFixed(2)}%)`);
