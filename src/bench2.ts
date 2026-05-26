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

// Count edges and nodes for stats
let totalNodes = 0;
let totalEdges = 0;
let leafNodes = 0;
let endNodes = 0;
let singleChildNodes = 0;
function countStats(node: TrieNode) {
  totalNodes++;
  totalEdges += node.children.size;
  if (node.children.size === 0) leafNodes++;
  if (node.isEnd) endNodes++;
  if (node.children.size === 1) singleChildNodes++;
  for (const child of node.children.values()) {
    countStats(child);
  }
}
countStats(root);
console.log(`\nTrie stats:`);
console.log(`  Nodes: ${totalNodes}, Edges: ${totalEdges}`);
console.log(`  Leaf nodes: ${leafNodes}, End-of-word nodes: ${endNodes}`);
console.log(`  Single-child nodes: ${singleChildNodes} (${(singleChildNodes/totalNodes*100).toFixed(1)}%)`);

// Distribution of child counts
const childCountDist = new Map<number, number>();
function countChildDist(node: TrieNode) {
  const cc = node.children.size;
  childCountDist.set(cc, (childCountDist.get(cc) ?? 0) + 1);
  for (const child of node.children.values()) countChildDist(child);
}
countChildDist(root);
console.log(`\n  Child count distribution:`);
for (const [cc, count] of [...childCountDist.entries()].sort((a,b) => a[0] - b[0])) {
  console.log(`    ${cc} children: ${count} nodes (${(count/totalNodes*100).toFixed(1)}%)`);
}

// ─── I. DFS trie baseline (char|flags byte per edge) ────────────────
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeNode(node: TrieNode) {
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
        serializeNode(child);
      }
    }
  }
  serializeNode(root);
  measure("I. DFS trie (char|flags, 1 byte/edge)", new Uint8Array(buf));
}

// ─── I2. Same but with path compression (merge single-child chains) ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // Path-compressed trie: when a node has exactly one child and is not an end-of-word,
  // merge it into a chain. Store chain as: length, chars, then the terminal node's children.
  // Format: for each edge at a branching/end node:
  //   If the path to next branch/end is a single char: same as before (1 byte)
  //   If it's a chain of N chars: special marker + N + chars
  // This is complex. Let's try a different approach.

  // Actually, let's try: for chains, just emit the chars with hasChildren=1, isEnd=0, isLast=1
  // That's already what happens. The question is whether we can encode chains more compactly.

  // Let's try: bit 7 = isLast, bit 6 = hasChildren, bit 5 = isEnd, bits 0-4 = char (0-25)
  // For a chain node (1 child, not end), we always have hasChildren=1, isLast=1, isEnd=0
  // So byte = char | 0xC0.  That's 192-217. Very repetitive -> gzip should love it.
  // That's exactly what we're already doing! Let's check the byte value distribution.

  const byteDist = new Map<number, number>();
  function serializeAndCount(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      byteDist.set(byte, (byteDist.get(byte) ?? 0) + 1);
      if (child.children.size > 0) {
        serializeAndCount(child);
      }
    }
  }
  serializeAndCount(root);

  console.log(`\n  DFS trie byte value distribution (top 30):`);
  const sortedByteValues = [...byteDist.entries()].sort((a, b) => b[1] - a[1]);
  for (let i = 0; i < Math.min(30, sortedByteValues.length); i++) {
    const [val, count] = sortedByteValues[i];
    const flags = [];
    if (val & 0x80) flags.push("last");
    if (val & 0x40) flags.push("hasCh");
    if (val & 0x20) flags.push("end");
    const ch = String.fromCharCode(97 + (val & 0x1f));
    console.log(`    byte ${val.toString().padStart(3)}: ${count.toString().padStart(6)} (${ch} ${flags.join(",")})`);
  }

  // Not re-measuring since it's the same as I
}

// ─── I3. DFS trie, but use 2 bits for child count class instead of hasChildren ───
// bit 7 = isLast, bits 5-6 = child_count_class (0=leaf, 1=1child, 2=2-3, 3=4+), bit 4 = isEnd, bits 0-3 = char
// Wait, char needs 5 bits (0-25). We only have 8 bits total. Current layout uses all 8 well.
// Let's try different flag encodings:

// ─── I4. DFS trie with delta-coded characters ───
{
  // Instead of absolute char values (0-25), store delta from previous sibling's char
  // This clusters values near 1 for consecutive siblings
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeDelta(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    let prevCh = 0;
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const delta = ch - prevCh; // always >= 0 for sorted children
      let byte = delta & 0x1f; // 5 bits for delta
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) {
        serializeDelta(child);
      }
      prevCh = ch;
    }
  }
  serializeDelta(root);
  measure("I4. DFS trie (delta-char|flags, 1 byte/edge)", new Uint8Array(buf));
}

// ─── I5. DFS trie with child-count as separate byte ─────────────────
{
  // For each node: first byte = child_count | (isEnd << 7)
  // Then for each child: char (0-25, 1 byte)
  // Then recursively serialize each child
  // This separates structure from content
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeNodeFirst(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    let header = keys.length; // 0-26
    if (node.isEnd) header |= 0x80;
    buf.push(header);
    // All child chars
    for (const ch of keys) buf.push(ch);
    // Then recurse into each child
    for (const ch of keys) {
      serializeNodeFirst(node.children.get(ch)!);
    }
  }
  serializeNodeFirst(root);
  measure("I5. DFS trie (node: count|isEnd + child chars)", new Uint8Array(buf));
}

// ─── I6. DFS trie with path compression ──────────────────────────────
{
  // Compress chains: when a node has exactly 1 child and is not end-of-word,
  // collect the chain and emit it as a run.
  // Format: byte with bit 7 = isLast, bit 6 = isChain, bit 5 = isEnd
  // If isChain=0: bits 0-4 = char (like before but no hasChildren flag)
  //   After this node's children (if any), children are determined by next bytes
  // If isChain=1: bits 0-4 = chain_length, followed by chain_length char bytes (0-25)
  //   The terminal node of the chain then has its own children/flags

  // Actually, simplest path compression: replace single-child chains with multi-char labels
  // per edge: [flags:u8] [char_count:u8?] [chars...]
  // But this adds complexity. Let's try something different.

  // Approach: DFS, but when we hit a single-child-non-end chain, emit a special "run" byte
  // 0-25: regular char edge (leaf, no children)
  // 26: run marker, followed by run_length:u8, then run_length chars, then flags of terminal
  // etc. Too complex for 100 lines of decoder.

  // Let's try the simplest win: just seeing if storing chars as ASCII (97-122) helps gzip
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeASCII(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      // Use char range 97-122 (ASCII a-z) plus flags in high bits...
      // wait, 97+25=122, and we need 3 flag bits. 122 + 32 = 154, + 64 = 186, + 128 = 250. Fits in a byte!
      let byte = ch + 97; // ASCII a-z
      if (child.isEnd) byte |= 0x80; // bit 7 is above 122, so no conflict
      // But wait: 97 | 0x80 = 225, and 122 | 0x80 = 250. Without flags: 97-122. With isEnd: 225-250.
      // We still need hasChildren and isLast... that's 2 more bits.
      // 97 in binary: 01100001. Bit 7 is free. Bit 6 is already set for some chars.
      // This won't work cleanly with ASCII. Let's drop this idea.
      // Instead let's try: separate the flags into a bitstream
      byte = ch; // back to 0-25
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) {
        serializeASCII(child);
      }
    }
  }
  serializeASCII(root);
  // Same as I, skip measuring
}

// ─── I7. DFS trie with BFS-ordered level serialization ───────────────
// Serialize by levels (BFS). Level 0 = root's children, level 1 = their children, etc.
// Each level: for each node at this level, emit edges with isLast flag.
// This groups similar patterns together.
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // BFS serialization
  let currentLevel: TrieNode[] = [root];
  let totalEdgesOutput = 0;

  while (currentLevel.length > 0) {
    const nextLevel: TrieNode[] = [];
    // Store number of nodes at this level? No, we can derive from edge counts.
    for (const node of currentLevel) {
      const keys = [...node.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const child = node.children.get(ch)!;
        let byte = ch;
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
        buf.push(byte);
        totalEdgesOutput++;
        if (child.children.size > 0) {
          nextLevel.push(child);
        }
      }
    }
    currentLevel = nextLevel;
  }
  measure("I7. BFS trie (char|flags, 1 byte/edge, level-ordered)", new Uint8Array(buf));
}

// ─── I8. DFS trie, split streams: flag bytes separate from char bytes ───
{
  const flagStream: number[] = [];
  const charStream: number[] = [];

  function serializeSplit(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      charStream.push(ch); // 0-25
      let flags = 0;
      if (child.isEnd) flags |= 1;
      if (child.children.size > 0) flags |= 2;
      if (i === keys.length - 1) flags |= 4;
      flagStream.push(flags); // 0-7
      if (child.children.size > 0) {
        serializeSplit(child);
      }
    }
  }
  serializeSplit(root);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  const fLen = flagStream.length;
  buf.push(fLen & 0xff, (fLen >> 8) & 0xff, (fLen >> 16) & 0xff, (fLen >> 24) & 0xff);
  for (const v of flagStream) buf.push(v);
  for (const v of charStream) buf.push(v);
  measure("I8. DFS trie, split streams (flags 0-7 | chars 0-25)", new Uint8Array(buf));
}

// ─── I9. DFS trie, flags as packed bits (3 bits each) ───
{
  const flagBits: number[] = []; // 3-bit values
  const charBytes: number[] = [];

  function serializePacked(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      charBytes.push(ch);
      let flags = 0;
      if (child.isEnd) flags |= 1;
      if (child.children.size > 0) flags |= 2;
      if (i === keys.length - 1) flags |= 4;
      flagBits.push(flags);
      if (child.children.size > 0) {
        serializePacked(child);
      }
    }
  }
  serializePacked(root);

  // Pack 3-bit flags: 8 flags per 3 bytes (24 bits)
  const packedFlags: number[] = [];
  for (let i = 0; i < flagBits.length; i += 8) {
    let bits = 0;
    for (let j = 0; j < 8 && i + j < flagBits.length; j++) {
      bits |= (flagBits[i + j] & 0x7) << (j * 3);
    }
    packedFlags.push(bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff);
  }

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  const fLen = packedFlags.length;
  const eLen = charBytes.length;
  buf.push(fLen & 0xff, (fLen >> 8) & 0xff, (fLen >> 16) & 0xff, (fLen >> 24) & 0xff);
  buf.push(eLen & 0xff, (eLen >> 8) & 0xff, (eLen >> 16) & 0xff, (eLen >> 24) & 0xff);
  for (const v of packedFlags) buf.push(v);
  for (const v of charBytes) buf.push(v);
  measure("I9. DFS trie, 3-bit packed flags + char bytes", new Uint8Array(buf));
}

// ─── I10. DFS trie, nibble-packed chars (2 chars per byte) ───
// chars are 0-25, so they fit in 5 bits. We can't do 2 per byte at 5 bits each.
// But we can do nibble: 4 bits only covers 0-15, not enough.
// Let's try: pack 3 chars per 2 bytes (5 bits each, 15 bits, plus 1 flag bit)
// Too complex for decoder. Skip.

// ─── I11. DFS trie, interleaved with front-coding concepts ───
// The trie naturally does front-coding. Let's see if we can improve the trie gzip ratio
// by reordering children: instead of alphabetical, order by subtree frequency.
{
  // Frequency-ordered children: most common first
  // This might help gzip by putting common patterns first
  function subtreeSize(node: TrieNode): number {
    let size = 1;
    for (const child of node.children.values()) {
      size += subtreeSize(child);
    }
    return size;
  }

  // Cache subtree sizes
  const sizeCache = new Map<TrieNode, number>();
  function cachedSize(node: TrieNode): number {
    let s = sizeCache.get(node);
    if (s !== undefined) return s;
    s = 1;
    for (const child of node.children.values()) {
      s += cachedSize(child);
    }
    sizeCache.set(node, s);
    return s;
  }

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeFreq(node: TrieNode) {
    // Sort children by subtree size descending (most common subtree first)
    const keys = [...node.children.keys()].sort((a, b) => {
      const sa = cachedSize(node.children.get(a)!);
      const sb = cachedSize(node.children.get(b)!);
      return sb - sa; // largest subtree first
    });
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) {
        serializeFreq(child);
      }
    }
  }
  serializeFreq(root);
  measure("I11. DFS trie (freq-ordered children)", new Uint8Array(buf));
}

// ─── I12. DFS trie, combine isEnd and isLast into 2-bit field, char in 5 bits, hasChildren as bit 7 ───
// Same bit layout, just checking if reordering flags helps gzip
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeReorder(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      // Rearrange bits: put hasChildren in bit 5 (commonly 1), isEnd in bit 6, isLast in bit 7
      let byte = ch; // bits 0-4
      if (child.children.size > 0) byte |= 0x20; // bit 5
      if (child.isEnd) byte |= 0x40; // bit 6
      if (i === keys.length - 1) byte |= 0x80; // bit 7
      buf.push(byte);
      if (child.children.size > 0) {
        serializeReorder(child);
      }
    }
  }
  serializeReorder(root);
  measure("I12. DFS trie (reordered flags: hasCh@5, end@6, last@7)", new Uint8Array(buf));
}

// ─── I13. DFS trie with path compression: merge single-child chains into labeled edges ───
{
  // Each edge can have multiple characters (a path label).
  // Format: [flags:u8] [extra_chars_count:u4|first_char:u4 ... wait this gets complex]
  // Simpler: flags byte where bit 0-4 = first char, bit 5 = isEnd of terminal, bit 6 = isLast,
  //          bit 7 = hasMoreChars (chain continues)
  // If hasMoreChars: next byte is next char in chain | flags
  // Terminal's hasChildren is implicit from context (after the chain, do more edges follow?)
  // Actually, let's use:
  // Byte: char (0-25) | isEnd<<5 | hasChildren<<6 | isLast<<7  (same as I)
  // But BEFORE this byte, if this edge is part of a chain, emit preceding chain chars with a run marker.
  //
  // Simplest path compression that keeps decoder simple:
  // When traversing DFS, if a node has exactly 1 child and is NOT end-of-word,
  // merge it: the edge label becomes multi-character.
  // Store as: first byte = char | flags (as before, but hasChildren refers to the terminal's children)
  //           if the edge spans N > 1 chars, emit a "chain length" prefix.
  //
  // Format: for each edge:
  //   If label is 1 char: [char|isEnd|hasChildren|isLast] (same as I)
  //   If label is N chars: [0x1F|isEnd|hasChildren|isLast] [N:u8] [char0] [char1] ... [charN-1]
  //     0x1F (31) is an unused char value (a-z = 0-25)
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializePC(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      let child = node.children.get(ch)!;

      // Collect chain
      const chain: number[] = [ch];
      while (child.children.size === 1 && !child.isEnd) {
        const nextCh = [...child.children.keys()][0];
        child = child.children.get(nextCh)!;
        chain.push(nextCh);
      }
      // child is now the terminal node of the chain

      const isLast = i === keys.length - 1;
      if (chain.length === 1) {
        let byte = chain[0];
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (isLast) byte |= 0x80;
        buf.push(byte);
      } else {
        let byte = 0x1f; // chain marker (char = 31, not a valid letter)
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (isLast) byte |= 0x80;
        buf.push(byte);
        buf.push(chain.length); // chain length
        for (const c of chain) buf.push(c); // chain chars
      }

      if (child.children.size > 0) {
        serializePC(child);
      }
    }
  }
  serializePC(root);

  // Verify by decoding
  let decodeIdx = 4; // skip header
  const decoded: string[] = [];
  const binData = new Uint8Array(buf);

  function decodePC(prefix: string) {
    while (decodeIdx < binData.length) {
      const byte = binData[decodeIdx++];
      const charVal = byte & 0x1f;
      const isEnd = !!(byte & 0x20);
      const hasChildren = !!(byte & 0x40);
      const isLast = !!(byte & 0x80);

      let label: string;
      if (charVal === 0x1f) {
        // Chain
        const chainLen = binData[decodeIdx++];
        let chars = "";
        for (let c = 0; c < chainLen; c++) {
          chars += String.fromCharCode(97 + binData[decodeIdx++]);
        }
        label = chars;
      } else {
        label = String.fromCharCode(97 + charVal);
      }

      const fullLabel = prefix + label;
      if (isEnd) decoded.push(fullLabel);
      if (hasChildren) decodePC(fullLabel);
      if (isLast) return;
    }
  }
  decodePC("");
  decoded.sort();

  if (decoded.length !== words.length) {
    console.error(`I13 FAIL: expected ${words.length}, got ${decoded.length}`);
  } else {
    let ok = true;
    for (let i = 0; i < words.length; i++) {
      if (decoded[i] !== words[i]) {
        console.error(`I13 FAIL at ${i}: expected "${words[i]}", got "${decoded[i]}"`);
        ok = false;
        break;
      }
    }
    if (ok) console.log("\nI13 path-compressed trie: roundtrip OK");
  }

  const chainCount = buf.filter((_, i) => i >= 4 && (buf[i] & 0x1f) === 0x1f).length;
  console.log(`  Chains: ${chainCount}, single-char edges: ${buf.length - 4 - chainCount * 1}`);

  measure("I13. DFS trie with path compression", new Uint8Array(buf));
}

// ─── I14. Combined: path compression + BFS ordering ───
// Skip, getting complex.

// ─── I15. DFS trie but omit hasChildren flag (use child count byte) ───
{
  // For each node, emit: child_count (1 byte), then for each child: char|isEnd (1 byte)
  // Then recursively children. No need for isLast or hasChildren flags.
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeCC(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    buf.push(keys.length); // child count
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      buf.push(byte);
    }
    // Recurse in order
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      if (child.children.size > 0) {
        serializeCC(child);
      }
    }
  }
  // Root node:
  {
    const keys = [...root.children.keys()].sort((a, b) => a - b);
    buf.push(keys.length);
    for (const ch of keys) {
      const child = root.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      buf.push(byte);
    }
    for (const ch of keys) {
      const child = root.children.get(ch)!;
      if (child.children.size > 0) {
        serializeCC(child);
      }
    }
  }
  // Wait, I called serializeCC wrong. Let me redo.
  buf.length = 4; // reset
  serializeCC(root);
  measure("I15. DFS trie (child_count + char|isEnd per child)", new Uint8Array(buf));
}

// ─── E. Global front-coded (share+26 marker) baseline for comparison ───
{
  function sharedPrefix(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared + 26);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("E. Global front-coded (share+26, baseline)", new Uint8Array(buf));
}

// ─── Print results ───────────────────────────────────────────────────
console.log("\n═══ TRIE VARIANT COMPARISON ═══\n");
console.log(
  "│ " +
    "Approach".padEnd(60) +
    " │ " +
    "Raw KB".padStart(8) +
    " │ " +
    "GZ KB".padStart(8) +
    " │"
);
console.log("│" + "─".repeat(62) + "│" + "─".repeat(10) + "│" + "─".repeat(10) + "│");

const sortedResults = [...results].sort((a, b) => a.gzBytes - b.gzBytes);
for (const r of sortedResults) {
  const rawKB = (r.rawBytes / 1024).toFixed(0);
  const gzKB = (r.gzBytes / 1024).toFixed(0);
  console.log(
    "│ " +
      r.name.padEnd(60).slice(0, 60) +
      " │ " +
      rawKB.padStart(8) +
      " │ " +
      gzKB.padStart(8) +
      " │"
  );
}
