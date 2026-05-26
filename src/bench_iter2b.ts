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

// Baseline
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

console.log("\n=== APPROACH A: Reduce flag entropy ===");

// Key insight: 58% of nodes have exactly 1 child. For those, isLast is ALWAYS true.
// hasChildren is also strongly correlated with depth.
// What if we use different byte encodings for common patterns?

// A1: Encode common patterns as single bytes
// The 8 flag combos and their frequencies:
{
  const comboCounts = new Array(8).fill(0);
  function countCombos(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
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
  console.log("  Flag combo frequencies:");
  const comboLabels = ["!end !child !last", "end !child !last", "!end child !last", "end child !last",
                       "!end !child last", "end !child last", "!end child last", "end child last"];
  for (let i = 0; i < 8; i++) {
    console.log(`    ${comboLabels[i].padEnd(22)}: ${comboCounts[i].toString().padStart(7)} (${(comboCounts[i]/1027809*100).toFixed(1)}%)`);
  }
}

// A2: Sort children by subtree size (DFS with largest subtree first)
// This creates longer repeated patterns since large common subtrees are adjacent
{
  // Count subtree sizes
  const subtreeSize = new Map<TrieNode, number>();
  function calcSize(node: TrieNode): number {
    let s = 1;
    for (const child of node.children.values()) s += calcSize(child);
    subtreeSize.set(node, s);
    return s;
  }
  calcSize(root);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    // Sort by subtree size descending (largest first)
    const keys = [...node.children.keys()].sort((a, b) =>
      (subtreeSize.get(node.children.get(b)!)!) - (subtreeSize.get(node.children.get(a)!)!)
    );
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
  addRow("A2. DFS trie, subtree-size sorted", new Uint8Array(buf));
}

// A3: Sort children by subtree size ascending (smallest first)
{
  const subtreeSize = new Map<TrieNode, number>();
  function calcSize(node: TrieNode): number {
    let s = 1;
    for (const child of node.children.values()) s += calcSize(child);
    subtreeSize.set(node, s);
    return s;
  }
  calcSize(root);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) =>
      (subtreeSize.get(node.children.get(a)!)!) - (subtreeSize.get(node.children.get(b)!)!)
    );
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
  addRow("A3. DFS trie, smallest-first sorted", new Uint8Array(buf));
}

console.log("\n=== APPROACH B: Eliminate hasChildren flag ===");

// B1: Remove hasChildren flag entirely. Instead, use isLast to know when to pop.
// After emitting all children of a node, the decoder reads the next byte.
// If isLast was set on the previous edge, we're going up; otherwise we're going deeper.
// Wait - we actually need hasChildren to know if we should descend.
// Alternative: use a special "end of children" marker byte instead of isLast.
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // Use byte 0x1f (char=31) as "go up" marker. No valid char uses 31.
  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      let byte = ch; // 0-25
      if (child.isEnd) byte |= 0x20;
      // No isLast or hasChildren flags needed
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
    buf.push(0x1f); // "go up" marker
  }
  serialize(root);
  addRow("B1. DFS trie + end-marker (0x1f)", new Uint8Array(buf));
}

// B2: Same but use 0x40 as marker (separates from char range)
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
    buf.push(0x40); // marker
  }
  serialize(root);
  addRow("B2. DFS trie + end-marker (0x40)", new Uint8Array(buf));
}

// B3: Use varint-encoded depth changes instead of markers
// Each edge: char(5) + isEnd(1). Then encode the depth change implicitly via bracket markers.
// Actually: "( char )" for leaf, "( char subtree )" for internal.
// Hmm, this needs explicit brackets. Let's try "depth change" approach:
// After each edge, if going deeper, nothing needed. If going back up, emit number of levels to go up.
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // Collect edges with depth info
  interface EdgeInfo { ch: number; isEnd: boolean; depthChange: number; }
  const edges: EdgeInfo[] = [];
  let curDepth = 0;

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      edges.push({ ch, isEnd: child.isEnd, depthChange: 0 /* filled later */ });
      if (child.children.size > 0) {
        curDepth++;
        serialize(child);
        curDepth--;
      }
    }
  }
  serialize(root);

  // Now encode: for each consecutive pair of edges, compute how many levels we popped
  // Actually let's use the standard approach but with child count per node
  // and drop hasChildren (if childCount > 0, we descend)
  // This is essentially approach 2b from iter1. Skip.
}

console.log("\n=== APPROACH C: Reduce byte range via mapping ===");

// C1: Map the 8 flag combos to 8 contiguous ranges of 26 chars
// combo 0 (most common) = bytes 0-25
// combo 1 = bytes 26-51, etc.
// This maximizes gzip's ability to use short Huffman codes for common combos
{
  // First find combo frequencies
  const comboCounts = new Array(8).fill(0);
  function countCombos2(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      comboCounts[combo]++;
      if (child.children.size > 0) countCombos2(child);
    }
  }
  countCombos2(root);

  // Sort combos by frequency (most frequent gets lowest offset)
  const comboOrder = [0,1,2,3,4,5,6,7].sort((a, b) => comboCounts[b] - comboCounts[a]);
  const comboToOffset = new Array(8);
  for (let i = 0; i < 8; i++) comboToOffset[comboOrder[i]] = i * 26;

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Store combo order (8 bytes)
  for (let i = 0; i < 8; i++) buf.push(comboOrder[i]);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let combo = 0;
      if (child.isEnd) combo |= 1;
      if (child.children.size > 0) combo |= 2;
      if (i === keys.length - 1) combo |= 4;
      buf.push(ch + comboToOffset[combo]);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("C1. DFS trie, combo-mapped bytes", new Uint8Array(buf));
}

// C2: Just use the natural combo mapping (isEnd<<6 | isLast<<5 | char)
// This keeps chars 0-25 in the low bits but with hasChildren removed (it's implicit)
// Wait, we can't remove hasChildren unless we have another way to know.
// Let's try a different bit arrangement that might create more repetition.

// C3: Separate the char stream and flag stream, but use a novel interleaving
// Interleave at the node level: all children chars, then recurse
{
  const charStream: number[] = [];
  const flagStream: number[] = [];

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    // Emit all children's chars
    for (let i = 0; i < keys.length; i++) {
      charStream.push(keys[i]);
      const child = node.children.get(keys[i])!;
      let f = 0;
      if (child.isEnd) f |= 1;
      if (child.children.size > 0) f |= 2;
      if (i === keys.length - 1) f |= 4;
      flagStream.push(f);
    }
    // Then recurse into children
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);

  const header = Buffer.alloc(8);
  header.writeUInt32LE(words.length, 0);
  header.writeUInt32LE(charStream.length, 4);
  const buf = Buffer.concat([header, Buffer.from(charStream), Buffer.from(flagStream)]);
  addRow("C3. Node-interleaved chars||flags", new Uint8Array(buf));
}

console.log("\n=== APPROACH D: DFS trie micro-optimizations ===");

// D1: Test all 26 rotations with desc+upper5 (previous winner approach)
{
  let bestRot = 0;
  let bestGz = Infinity;

  for (let rot = 0; rot < 26; rot++) {
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
    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 }).length;
    if (gz < bestGz) { bestGz = gz; bestRot = rot; }
  }
  console.log(`  Best rotation (desc+upper5): rot=${bestRot}, gz=${bestGz} bytes (${(bestGz/1024).toFixed(0)} KB)`);

  // Also test all rotations with asc+lower5 (standard layout)
  let bestRot2 = 0;
  let bestGz2 = Infinity;

  for (let rot = 0; rot < 26; rot++) {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    function serialize(node: TrieNode) {
      const keys = [...node.children.keys()].sort((a, b) => ((a + rot) % 26) - ((b + rot) % 26));
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
    if (gz < bestGz2) { bestGz2 = gz; bestRot2 = rot; }
  }
  console.log(`  Best rotation (asc+lower5): rot=${bestRot2}, gz=${bestGz2} bytes (${(bestGz2/1024).toFixed(0)} KB)`);

  // D1: char<<3 | flags with best rotation
  {
    const rot = bestRot;
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
    addRow(`D1. desc+upper5 rot=${rot}`, new Uint8Array(buf));
  }

  // D1b: standard layout with best rotation
  {
    const rot = bestRot2;
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    function serialize(node: TrieNode) {
      const keys = [...node.children.keys()].sort((a, b) => ((a + rot) % 26) - ((b + rot) % 26));
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
    addRow(`D1b. asc+lower5 rot=${rot}`, new Uint8Array(buf));
  }
}

// D2: Try XOR-based char transform (XOR each char with its parent char)
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode, parentCh: number) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const xored = ch ^ parentCh;
      let byte = xored & 0x1f;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) serialize(child, ch);
    }
  }
  serialize(root, 0);
  addRow("D2. DFS trie XOR parent char", new Uint8Array(buf));
}

// D3: Try mapping chars via bigram frequency (context-dependent mapping)
// For each parent char, remap children chars by frequency of that bigram
{
  // Collect bigram frequencies from the trie
  const bigramFreq = Array.from({length: 27}, () => new Array(26).fill(0)); // 27 parent contexts (0-25 + root=26)

  function countBigrams(node: TrieNode, parentCtx: number) {
    for (const [ch, child] of node.children) {
      bigramFreq[parentCtx][ch]++;
      countBigrams(child, ch);
    }
  }
  countBigrams(root, 26);

  // For each context, create a ranking
  const contextMap = Array.from({length: 27}, (_, ctx) => {
    const ranked = [...Array(26).keys()].sort((a, b) => bigramFreq[ctx][b] - bigramFreq[ctx][a]);
    const map = new Array(26);
    for (let i = 0; i < 26; i++) map[ranked[i]] = i;
    return map;
  });

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Store all 27 mapping tables (27 * 26 = 702 bytes, negligible)
  for (let ctx = 0; ctx < 27; ctx++) {
    // Store the ranked order so decoder can reconstruct
    const ranked = [...Array(26).keys()].sort((a, b) => bigramFreq[ctx][b] - bigramFreq[ctx][a]);
    for (let i = 0; i < 26; i++) buf.push(ranked[i]);
  }

  function serialize(node: TrieNode, parentCtx: number) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const mapped = contextMap[parentCtx][ch];
      let byte = mapped;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) serialize(child, ch);
    }
  }
  serialize(root, 26);
  addRow("D3. DFS trie context-dependent char map", new Uint8Array(buf));
}

console.log("\n=== APPROACH E: Multi-stream with BWT-like transform ===");

// E1: Apply BWT to the DFS byte stream before gzipping
// BWT itself isn't trivially available, but we can try MTF (Move-to-Front)
{
  // First, generate standard DFS bytes
  const dfsBuf: number[] = [];
  function genDFS(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
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

  // Apply MTF transform
  const alphabet = [...Array(256).keys()];
  const mtfOut: number[] = [];
  const n = words.length;
  mtfOut.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  const list = [...alphabet];
  for (const b of dfsBuf) {
    const idx = list.indexOf(b);
    mtfOut.push(idx);
    // Move to front
    list.splice(idx, 1);
    list.unshift(b);
  }
  addRow("E1. DFS trie + MTF transform", new Uint8Array(mtfOut));
}

// E2: Delta-encode the DFS byte stream (each byte minus previous)
{
  const dfsBuf: number[] = [];
  function genDFS2(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      dfsBuf.push(byte);
      if (child.children.size > 0) genDFS2(child);
    }
  }
  genDFS2(root);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  let prev = 0;
  for (const b of dfsBuf) {
    buf.push((b - prev + 256) & 0xff);
    prev = b;
  }
  addRow("E2. DFS trie + delta transform", new Uint8Array(buf));
}

console.log("\n=== APPROACH F: Hybrid trie + front-coding ===");

// F1: Use trie for structure but front-code the labels
// This is a variant where we store the trie depth changes + word suffixes
{
  // Generate word list with trie-derived prefix sharing
  // For each word, compute its depth in the trie = shared prefix with previous word in DFS order
  const dfWords: string[] = [];
  function collectDFS(node: TrieNode, prefix: string) {
    if (node.isEnd) dfWords.push(prefix);
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (const ch of keys) {
      collectDFS(node.children.get(ch)!, prefix + String.fromCharCode(ch + 97));
    }
  }
  collectDFS(root, "");

  // Front-code with depth-based sharing
  const buf: number[] = [];
  const n = dfWords.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  let prev = "";
  for (const w of dfWords) {
    let shared = 0;
    while (shared < prev.length && shared < w.length && prev[shared] === w[shared]) shared++;
    buf.push(shared + 26); // shared + 26 marker (front-coding approach E from iter1)
    for (let i = shared; i < w.length; i++) buf.push(w.charCodeAt(i) - 97);
    prev = w;
  }
  addRow("F1. Front-coded (DFS word order)", new Uint8Array(buf));
}

// F2: Front-coded with varint share length (share can be > 230 for DFS order)
{
  const dfWords: string[] = [];
  function collectDFS2(node: TrieNode, prefix: string) {
    if (node.isEnd) dfWords.push(prefix);
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (const ch of keys) {
      collectDFS2(node.children.get(ch)!, prefix + String.fromCharCode(ch + 97));
    }
  }
  collectDFS2(root, "");

  // Check: what's the max shared prefix in DFS order?
  let maxShared = 0;
  let prev2 = "";
  for (const w of dfWords) {
    let shared = 0;
    while (shared < prev2.length && shared < w.length && prev2[shared] === w[shared]) shared++;
    if (shared > maxShared) maxShared = shared;
    prev2 = w;
  }
  console.log(`  Max shared prefix (DFS order): ${maxShared}`);

  // Average shared prefix
  let totalShared = 0;
  prev2 = "";
  for (const w of dfWords) {
    let shared = 0;
    while (shared < prev2.length && shared < w.length && prev2[shared] === w[shared]) shared++;
    totalShared += shared;
    prev2 = w;
  }
  console.log(`  Avg shared prefix (DFS order): ${(totalShared / dfWords.length).toFixed(2)}`);
}

console.log("\n=== APPROACH G: Nibble-based encoding ===");

// G1: Pack char (0-25) into high nibble, flags into low nibble
// Chars 0-25 fit in 5 bits. If we use high nibble (4 bits) we can't fit all 26.
// But 26 chars need 5 bits. High nibble is only 4 bits. So this doesn't work directly.
// However: what if we use 2 nibbles per edge, first nibble = char/2, second = char%2 + flags?
// That's worse. Let's try something else.

// G2: Use the observation that many leaf edges have the pattern (char | 0xA0)
// meaning isEnd + isLast + no children. For these, char must be in 0-25.
// So bytes 0xA0-0xB9 are leaf+last edges. Very common!
// What if we RLE these common byte values?
{
  const dfsBuf: number[] = [];
  function genDFS3(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      dfsBuf.push(byte);
      if (child.children.size > 0) genDFS3(child);
    }
  }
  genDFS3(root);

  // Count byte frequencies
  const freq256 = new Array(256).fill(0);
  for (const b of dfsBuf) freq256[b]++;

  // Show top 20 most common bytes
  const ranked = [...Array(256).keys()].sort((a, b) => freq256[b] - freq256[a]);
  console.log("  Top 20 byte values:");
  for (let i = 0; i < 20; i++) {
    const b = ranked[i];
    const ch = b & 0x1f;
    const isEnd = (b >> 5) & 1;
    const hasChild = (b >> 6) & 1;
    const isLast = (b >> 7) & 1;
    console.log(`    0x${b.toString(16).padStart(2, '0')} (ch=${String.fromCharCode(ch+97)}, end=${isEnd}, child=${hasChild}, last=${isLast}): ${freq256[b]} (${(freq256[b]/dfsBuf.length*100).toFixed(1)}%)`);
  }
}

// G3: Remap byte values so most frequent ones use lowest values (0-based)
{
  const dfsBuf: number[] = [];
  function genDFS4(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      dfsBuf.push(byte);
      if (child.children.size > 0) genDFS4(child);
    }
  }
  genDFS4(root);

  const freq256 = new Array(256).fill(0);
  for (const b of dfsBuf) freq256[b]++;
  const ranked = [...Array(256).keys()].sort((a, b) => freq256[b] - freq256[a]);
  const remap = new Array(256);
  for (let i = 0; i < 256; i++) remap[ranked[i]] = i;

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Store remap table (only non-zero entries matter)
  const usedCount = ranked.filter(b => freq256[b] > 0).length;
  buf.push(usedCount);
  for (let i = 0; i < usedCount; i++) buf.push(ranked[i]);
  // Remapped stream
  for (const b of dfsBuf) buf.push(remap[b]);
  addRow("G3. DFS trie freq-remapped bytes", new Uint8Array(buf));
}

console.log("\n=== APPROACH H: Two-pass encoding ===");

// H1: First pass emits the trie structure (hasChildren + isLast only, 4 combos = 2 bits each).
// Second pass emits char + isEnd for each edge.
// The structure bitstream is very compressible. The char+isEnd stream has ~6 bits entropy.
{
  const structBits: number[] = [];
  const dataBytes: number[] = [];

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const hasChild = child.children.size > 0 ? 1 : 0;
      const isLast = i === keys.length - 1 ? 1 : 0;
      structBits.push(hasChild, isLast);
      let dataByte = ch;
      if (child.isEnd) dataByte |= 0x20;
      dataBytes.push(dataByte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);

  // Pack struct bits
  const structPacked = new Uint8Array(Math.ceil(structBits.length / 8));
  for (let i = 0; i < structBits.length; i++) {
    if (structBits[i]) structPacked[i >> 3] |= (1 << (i & 7));
  }

  const header = Buffer.alloc(8);
  header.writeUInt32LE(words.length, 0);
  header.writeUInt32LE(dataBytes.length, 4);
  const buf = Buffer.concat([header, structPacked, Buffer.from(dataBytes)]);
  addRow("H1. 2-pass: struct bits + char|end", new Uint8Array(buf));
}

// H2: Three streams: structure (2-bit), chars (5-bit), isEnd (1-bit)
{
  const structBits: number[] = [];
  const charVals: number[] = [];
  const endBits: number[] = [];

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      structBits.push(child.children.size > 0 ? 1 : 0, i === keys.length - 1 ? 1 : 0);
      charVals.push(ch);
      endBits.push(child.isEnd ? 1 : 0);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);

  const structPacked = new Uint8Array(Math.ceil(structBits.length / 8));
  for (let i = 0; i < structBits.length; i++) {
    if (structBits[i]) structPacked[i >> 3] |= (1 << (i & 7));
  }

  const charPacked = new Uint8Array(Math.ceil(charVals.length * 5 / 8));
  let bp = 0;
  for (const c of charVals) {
    const byteIdx = bp >> 3;
    const bitOff = bp & 7;
    charPacked[byteIdx] |= (c << bitOff) & 0xff;
    if (bitOff > 3) charPacked[byteIdx + 1] |= (c >> (8 - bitOff));
    bp += 5;
  }

  const endPacked = new Uint8Array(Math.ceil(endBits.length / 8));
  for (let i = 0; i < endBits.length; i++) {
    if (endBits[i]) endPacked[i >> 3] |= (1 << (i & 7));
  }

  const header = Buffer.alloc(8);
  header.writeUInt32LE(words.length, 0);
  header.writeUInt32LE(charVals.length, 4);
  const buf = Buffer.concat([header, structPacked, charPacked, endPacked]);
  addRow("H2. 3-stream: struct+5bit chars+end", new Uint8Array(buf));
}

console.log("\n=== APPROACH I: Compact DAWG with reachability ===");

// I1: For the DAWG, instead of DFS+backref, serialize as a flat table.
// Use 2-byte fixed-size node IDs (since DAWG has ~160K nodes, 18 bits needed)
// Pack: isEnd(1) + childCount(5) + children: (char(5) + nodeId(18)) packed
{
  // Build DAWG
  const sigs = new Map<TrieNode, string>();
  function sig2(node: TrieNode): string {
    const cached = sigs.get(node);
    if (cached) return cached;
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    const s = (node.isEnd ? "1" : "0") + "[" + keys.map(ch => `${ch}:${sig2(node.children.get(ch)!)}`).join(",") + "]";
    sigs.set(node, s);
    return s;
  }

  const sigToCanon = new Map<string, TrieNode>();
  const nodeToSigId = new Map<TrieNode, number>();
  const allSigs: string[] = [];

  function buildDAWG(node: TrieNode) {
    const s = sig2(node);
    if (!sigToCanon.has(s)) {
      const id = allSigs.length;
      allSigs.push(s);
      sigToCanon.set(s, node);
      nodeToSigId.set(node, id);
      for (const child of node.children.values()) buildDAWG(child);
    } else {
      nodeToSigId.set(node, allSigs.indexOf(s));
    }
  }
  buildDAWG(root);

  console.log(`  DAWG unique nodes: ${allSigs.length}`);

  // Map every trie node to its canonical DAWG ID
  function getDAWGId(node: TrieNode): number {
    const s = sig2(node);
    return allSigs.indexOf(s);
  }

  // Fixed-size 3-byte node IDs (since >65536 nodes)
  const buf: number[] = [];
  buf.push(words.length & 0xff, (words.length >> 8) & 0xff, (words.length >> 16) & 0xff, (words.length >> 24) & 0xff);
  buf.push(allSigs.length & 0xff, (allSigs.length >> 8) & 0xff, (allSigs.length >> 16) & 0xff, (allSigs.length >> 24) & 0xff);

  for (const s of allSigs) {
    const canon = sigToCanon.get(s)!;
    const keys = [...canon.children.keys()].sort((a, b) => a - b);
    let header = keys.length;
    if (canon.isEnd) header |= 0x80;
    buf.push(header);
    for (const ch of keys) {
      const childId = getDAWGId(canon.children.get(ch)!);
      // Pack char(5 bits) + childId(18 bits) = 23 bits = 3 bytes
      buf.push(ch);
      buf.push(childId & 0xff);
      buf.push((childId >> 8) & 0xff);
      if (childId > 65535) buf.push((childId >> 16) & 0xff);
      else buf.push(0);
    }
  }
  addRow("I1. DAWG flat table (3-byte IDs)", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// FINAL TABLE
// ═══════════════════════════════════════════════════════════════════════
console.log("\n");
console.log("=".repeat(80));
console.log("                        ITERATION 2B COMPARISON TABLE");
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

console.log("\n" + "=".repeat(80));
const best = rows[0];
if (best.gz < baseline.gz) {
  console.log(`\nBEST: ${best.name}`);
  console.log(`  Raw: ${(best.raw / 1024).toFixed(0)} KB, Gzipped: ${(best.gz / 1024).toFixed(0)} KB (${best.gz} bytes)`);
  console.log(`  Improvement: ${baseline.gz - best.gz} bytes (${((1 - best.gz/baseline.gz)*100).toFixed(2)}%)`);
} else {
  console.log(`\nNo improvement. Baseline remains best at ${baseline.gz} bytes.`);
}
