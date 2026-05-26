import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

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
interface TrieNode {
  children: Map<number, TrieNode>;
  isEnd: boolean;
  id?: number;
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

// Count nodes
let nodeCount = 0;
function countNodes(node: TrieNode) {
  nodeCount++;
  for (const child of node.children.values()) countNodes(child);
}
countNodes(root);
console.log(`Trie nodes: ${nodeCount}, edges: ${nodeCount - 1}\n`);

// ─── Results ─────────────────────────────────────────────────────────
interface Row { name: string; raw: number; gz: number; }
const rows: Row[] = [];

function addRow(name: string, data: Uint8Array) {
  const gz = gzipSync(Buffer.from(data), { level: 9 }).length;
  rows.push({ name, raw: data.length, gz });
  console.log(`  ${name}: raw=${(data.length/1024).toFixed(0)} KB, gz=${(gz/1024).toFixed(0)} KB`);
}

// ═══════════════════════════════════════════════════════════════════════
// 0. BASELINES
// ═══════════════════════════════════════════════════════════════════════
console.log("=== BASELINES ===");

// Raw text gzipped
{
  const d = new TextEncoder().encode(words.join("\n") + "\n");
  addRow("Raw text (baseline)", d);
}

// DFS trie standard (the 589 KB baseline to beat)
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
  addRow("DFS trie standard (prev best)", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// 1. PATRICIA / RADIX TRIE (path compression)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 1. PATRICIA / RADIX TRIE ===");
{
  // Build radix trie by compressing single-child chains
  interface RadixNode {
    label: number[]; // edge label chars (0-25)
    isEnd: boolean;
    children: Map<number, RadixNode>; // keyed by first char of label
  }

  function buildRadix(trie: TrieNode): RadixNode {
    const rn: RadixNode = { label: [], isEnd: trie.isEnd, children: new Map() };
    for (const [ch, child] of trie.children) {
      const label = [ch];
      let cur = child;
      // Compress single-child, non-end chains
      while (cur.children.size === 1 && !cur.isEnd) {
        const [nextCh, nextChild] = [...cur.children.entries()][0];
        label.push(nextCh);
        cur = nextChild;
      }
      const rChild = buildRadix(cur);
      rChild.label = label;
      rChild.isEnd = cur.isEnd;
      rn.children.set(ch, rChild);
    }
    return rn;
  }

  const radixRoot = buildRadix(root);

  // Count radix nodes
  let radixNodes = 0;
  function countRadix(n: RadixNode) {
    radixNodes++;
    for (const c of n.children.values()) countRadix(c);
  }
  countRadix(radixRoot);
  console.log(`  Radix nodes: ${radixNodes}`);

  // Approach 1a: flags byte + label length byte + label chars
  // flags: bit 5 = isEnd, bit 6 = hasChildren, bit 7 = isLast
  // label length in bits 0-4 (max 31)
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    function serialize(node: RadixNode) {
      const keys = [...node.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const child = node.children.get(keys[i])!;
        const label = child.label;
        // flags byte: bit 5=end, 6=hasChildren, 7=isLast
        let flags = 0;
        if (child.isEnd) flags |= 0x20;
        if (child.children.size > 0) flags |= 0x40;
        if (i === keys.length - 1) flags |= 0x80;
        // Encode label length separately since can be > 31
        buf.push(flags);
        buf.push(label.length); // u8 label length
        for (const ch of label) buf.push(ch);
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(radixRoot);
    addRow("1a. Patricia: flags+len+label", new Uint8Array(buf));
  }

  // Approach 1b: For short labels (<=5), pack length in low bits of flags.
  // For longer, use an extra length byte.
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    function serialize(node: RadixNode) {
      const keys = [...node.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const child = node.children.get(keys[i])!;
        const label = child.label;
        let flags = 0;
        if (child.isEnd) flags |= 0x20;
        if (child.children.size > 0) flags |= 0x40;
        if (i === keys.length - 1) flags |= 0x80;
        if (label.length <= 31) {
          flags |= (label.length & 0x1f);
          buf.push(flags);
        } else {
          flags |= 0x00; // length 0 signals "extra byte follows"
          buf.push(flags, label.length);
        }
        for (const ch of label) buf.push(ch);
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(radixRoot);
    addRow("1b. Patricia: packed flags+label", new Uint8Array(buf));
  }

  // Approach 1c: first char in flags byte (5 bits), rest of label follows with length
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    function serialize(node: RadixNode) {
      const keys = [...node.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const child = node.children.get(keys[i])!;
        const label = child.label;
        let byte = label[0]; // 5 bits for first char
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
        buf.push(byte);
        // If label > 1 char, emit extra chars with continuation
        if (label.length > 1) {
          buf.push(label.length - 1); // remaining count
          for (let j = 1; j < label.length; j++) buf.push(label[j]);
        }
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(radixRoot);
    addRow("1c. Patricia: char+flags, extra label", new Uint8Array(buf));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 2. CHILD-COUNT ENCODING
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 2. CHILD-COUNT ENCODING ===");
{
  // Instead of isLast flag, store child count at each node
  // byte = char(5) | isEnd(1) | hasChildren(1), then if hasChildren: u8 childCount
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      let byte = ch; // bits 0-4
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      buf.push(byte);
      if (child.children.size > 0) {
        buf.push(child.children.size);
        serialize(child);
      }
    }
  }
  // Root gets child count too
  buf.push(root.children.size);
  serialize(root);
  addRow("2a. Child-count (u8 per internal node)", new Uint8Array(buf));
}

// 2b: Child count packed in 5 bits (max 26, fits in 5 bits)
{
  // byte = char(5) | isEnd(1) | hasChildren(1) | unused(1)
  // if hasChildren: next byte has child count in low 5 bits
  // Actually 26 fits in 5 bits. Let's pack: high 3 = flags, low 5 = char; if hasChildren: next byte low 5 = count
  // Same as 2a really. Let's try something different:
  // No isLast flag at all. childCount precedes each set of children.
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    buf.push(keys.length); // child count
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      let byte = ch; // bits 0-4
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      // no isLast flag needed since we know count
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("2b. Child-count prefix per node", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// 3. SPLIT STREAMS (chars separate from flags)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 3. SPLIT STREAMS ===");
{
  const chars: number[] = [];
  const flags: number[] = [];
  const n = words.length;

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      chars.push(ch); // 0-25
      let f = 0;
      if (child.isEnd) f |= 0x01;
      if (child.children.size > 0) f |= 0x02;
      if (i === keys.length - 1) f |= 0x04;
      flags.push(f); // 0-7 (3 bits used)
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);

  // 3a: concatenate chars then flags
  {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(n, 0);
    header.writeUInt32LE(chars.length, 4);
    header.writeUInt32LE(flags.length, 8);
    const buf = Buffer.concat([header, Buffer.from(chars), Buffer.from(flags)]);
    addRow("3a. Split streams (chars||flags)", new Uint8Array(buf));
  }

  // 3b: interleaved in groups (64 chars then 64 flags)
  {
    const groupSize = 64;
    const parts: number[] = [];
    parts.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    parts.push(chars.length & 0xff, (chars.length >> 8) & 0xff, (chars.length >> 16) & 0xff, (chars.length >> 24) & 0xff);
    for (let i = 0; i < chars.length; i += groupSize) {
      const end = Math.min(i + groupSize, chars.length);
      for (let j = i; j < end; j++) parts.push(chars[j]);
      for (let j = i; j < end; j++) parts.push(flags[j]);
    }
    addRow("3b. Split interleaved (64-groups)", new Uint8Array(parts));
  }

  // 3c: Pack flags as bitstream (3 bits each)
  {
    const header = Buffer.alloc(12);
    header.writeUInt32LE(n, 0);
    header.writeUInt32LE(chars.length, 4);
    // Pack flags: 3 bits each
    const flagBytes = Math.ceil(flags.length * 3 / 8);
    header.writeUInt32LE(flagBytes, 8);
    const flagBuf = new Uint8Array(flagBytes);
    let bitPos = 0;
    for (const f of flags) {
      const byteIdx = bitPos >> 3;
      const bitOff = bitPos & 7;
      flagBuf[byteIdx] |= (f << bitOff) & 0xff;
      if (bitOff > 5) flagBuf[byteIdx + 1] |= (f >> (8 - bitOff));
      bitPos += 3;
    }
    const buf = Buffer.concat([header, Buffer.from(chars), flagBuf]);
    addRow("3c. Split: chars + packed 3-bit flags", new Uint8Array(buf));
  }

  // 3d: Pack chars as 5-bit stream
  {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(n, 0);
    header.writeUInt32LE(chars.length, 4);
    const charBitLen = Math.ceil(chars.length * 5 / 8);
    const charBuf = new Uint8Array(charBitLen);
    let bitPos = 0;
    for (const c of chars) {
      const byteIdx = bitPos >> 3;
      const bitOff = bitPos & 7;
      charBuf[byteIdx] |= (c << bitOff) & 0xff;
      if (bitOff > 3) charBuf[byteIdx + 1] |= (c >> (8 - bitOff));
      bitPos += 5;
    }
    const buf = Buffer.concat([header, charBuf, Buffer.from(flags)]);
    addRow("3d. Split: packed 5-bit chars + flags", new Uint8Array(buf));
  }

  // 3e: both packed (5-bit chars + 3-bit flags = 8 bits, but separated)
  {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(n, 0);
    header.writeUInt32LE(chars.length, 4);
    const charBitLen = Math.ceil(chars.length * 5 / 8);
    const charBuf = new Uint8Array(charBitLen);
    let bitPos = 0;
    for (const c of chars) {
      const byteIdx = bitPos >> 3;
      const bitOff = bitPos & 7;
      charBuf[byteIdx] |= (c << bitOff) & 0xff;
      if (bitOff > 3) charBuf[byteIdx + 1] |= (c >> (8 - bitOff));
      bitPos += 5;
    }
    const flagBitLen = Math.ceil(flags.length * 3 / 8);
    const flagBuf = new Uint8Array(flagBitLen);
    bitPos = 0;
    for (const f of flags) {
      const byteIdx = bitPos >> 3;
      const bitOff = bitPos & 7;
      flagBuf[byteIdx] |= (f << bitOff) & 0xff;
      if (bitOff > 5) flagBuf[byteIdx + 1] |= (f >> (8 - bitOff));
      bitPos += 3;
    }
    const buf = Buffer.concat([header, charBuf, flagBuf]);
    addRow("3e. Split: 5-bit chars + 3-bit flags", new Uint8Array(buf));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 4. DAWG (Directed Acyclic Word Graph) with back-references
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 4. DAWG ===");
{
  // Build minimized DAWG by merging equivalent subtrees bottom-up
  // First, compute a signature for each node
  const sigMap = new Map<string, number>(); // signature -> canonical node ID
  const nodeById = new Map<number, TrieNode>(); // id -> node
  const nodeToSig = new Map<TrieNode, string>();
  let nextId = 0;

  // Assign signatures bottom-up
  function computeSig(node: TrieNode): string {
    const cached = nodeToSig.get(node);
    if (cached !== undefined) return cached;
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    const childSigs: string[] = [];
    for (const ch of keys) {
      const childSig = computeSig(node.children.get(ch)!);
      childSigs.push(`${ch}:${childSig}`);
    }
    const sig = (node.isEnd ? "1" : "0") + "[" + childSigs.join(",") + "]";
    nodeToSig.set(node, sig);
    return sig;
  }
  computeSig(root);

  // Deduplicate: map each unique signature to a canonical ID
  const sigToId = new Map<string, number>();
  const nodeToCanonId = new Map<TrieNode, number>();

  function assignIds(node: TrieNode): number {
    const sig = nodeToSig.get(node)!;
    const existing = sigToId.get(sig);
    if (existing !== undefined) {
      nodeToCanonId.set(node, existing);
      return existing;
    }
    const id = nextId++;
    sigToId.set(sig, id);
    nodeToCanonId.set(node, id);
    nodeById.set(id, node);
    // Process children to assign their IDs
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (const ch of keys) {
      assignIds(node.children.get(ch)!);
    }
    return id;
  }
  assignIds(root);
  const dawgNodeCount = nextId;
  console.log(`  DAWG nodes: ${dawgNodeCount}`);

  // 4a: DFS serialization with inline/backref
  // First visit = inline (emit edges), subsequent = backref (varint ID)
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(dawgNodeCount & 0xff, (dawgNodeCount >> 8) & 0xff, (dawgNodeCount >> 16) & 0xff, (dawgNodeCount >> 24) & 0xff);

    const serialized = new Set<number>();
    const nodeOffsets = new Map<number, number>(); // id -> offset in buf where it was serialized

    function writeVarint(val: number) {
      while (val >= 0x80) {
        buf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      buf.push(val);
    }

    function serialize(node: TrieNode) {
      const canonId = nodeToCanonId.get(node)!;

      if (serialized.has(canonId)) {
        // Back reference: write special marker then varint ID
        buf.push(0xff); // marker for backref (can't be a normal edge byte since char max is 25)
        writeVarint(canonId);
        return;
      }

      serialized.add(canonId);
      nodeOffsets.set(canonId, buf.length);

      const canonNode = nodeById.get(canonId)!;
      const keys = [...canonNode.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const child = canonNode.children.get(ch)!;
        const childId = nodeToCanonId.get(child)!;
        let byte = ch;
        if (child.isEnd || nodeById.get(childId)!.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
        buf.push(byte);
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(root);
    addRow("4a. DAWG DFS + varint backref", new Uint8Array(buf));
  }

  // 4b: DAWG as adjacency list: for each unique node, list its edges
  // Node table: nodeId -> (isEnd, edges[])
  // edge = (char, targetNodeId)
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(dawgNodeCount & 0xff, (dawgNodeCount >> 8) & 0xff, (dawgNodeCount >> 16) & 0xff, (dawgNodeCount >> 24) & 0xff);

    function writeVarint(val: number) {
      while (val >= 0x80) {
        buf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      buf.push(val);
    }

    // Serialize nodes in order 0..dawgNodeCount-1
    for (let id = 0; id < dawgNodeCount; id++) {
      const node = nodeById.get(id)!;
      const keys = [...node.children.keys()].sort((a, b) => a - b);
      // header: childCount | (isEnd << 5)
      let header = keys.length;
      if (node.isEnd) header |= 0x80;
      buf.push(header);
      for (const ch of keys) {
        const child = node.children.get(ch)!;
        const childId = nodeToCanonId.get(child)!;
        buf.push(ch);
        writeVarint(childId);
      }
    }
    addRow("4b. DAWG adjacency (varint IDs)", new Uint8Array(buf));
  }

  // 4c: DAWG DFS - serialize unique subtrees inline, use delta-encoded backrefs
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    const serialized2 = new Set<number>();

    function writeVarint2(val: number) {
      while (val >= 0x80) {
        buf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      buf.push(val);
    }

    // Instead of node IDs, use byte offset for back-references
    const nodeOffset2 = new Map<number, number>();

    function serialize2(node: TrieNode): void {
      const canonId = nodeToCanonId.get(node)!;

      if (serialized2.has(canonId)) {
        // Back-reference using byte offset delta
        const targetOff = nodeOffset2.get(canonId)!;
        const delta = buf.length - targetOff;
        buf.push(0xff);
        writeVarint2(delta);
        return;
      }

      serialized2.add(canonId);
      nodeOffset2.set(canonId, buf.length);

      const canonNode = nodeById.get(canonId)!;
      const keys = [...canonNode.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const child = canonNode.children.get(ch)!;
        const childId = nodeToCanonId.get(child)!;
        let byte = ch;
        if (nodeById.get(childId)!.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
        buf.push(byte);
        if (child.children.size > 0) serialize2(child);
      }
    }
    serialize2(root);
    addRow("4c. DAWG DFS + delta backref", new Uint8Array(buf));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 5. DELTA-ENCODED SIBLING CHARS
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 5. DELTA-ENCODED SIBLING CHARS ===");
{
  // Children are sorted a-z, so the first child char is absolute,
  // subsequent siblings store delta from previous sibling char.
  // Deltas are small positive numbers.
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    let prevCh = 0;
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const delta = i === 0 ? ch : (ch - prevCh);
      // delta fits in 5 bits (max 25)
      let byte = delta & 0x1f;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      prevCh = ch;
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("5. Delta-encoded sibling chars", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// 6. LOUDS (Level-Order Unary Degree Sequence)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 6. LOUDS TRIE ===");
{
  // Level-order traversal
  // Structure: for each node, write degree as unary: degree 1s followed by a 0
  // Labels: for each node's children, write their char labels
  // isEnd: bitarray marking which nodes end a word

  const queue: TrieNode[] = [root];
  const structBits: number[] = []; // 1 and 0 bits
  const labels: number[] = [];
  const endBits: number[] = [];

  // Super-root: 1 child (root), so write "10"
  structBits.push(1, 0);
  endBits.push(root.isEnd ? 1 : 0);

  let qi = 0;
  while (qi < queue.length) {
    const node = queue[qi++];
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (const ch of keys) {
      structBits.push(1);
      labels.push(ch);
      const child = node.children.get(ch)!;
      endBits.push(child.isEnd ? 1 : 0);
      queue.push(child);
    }
    structBits.push(0);
  }

  // Pack bits into bytes
  function packBits(bits: number[]): Uint8Array {
    const out = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) out[i >> 3] |= (1 << (i & 7));
    }
    return out;
  }

  const structBytes = packBits(structBits);
  const endBytes = packBits(endBits);

  // Pack labels as 5-bit values
  const labelBitLen = Math.ceil(labels.length * 5 / 8);
  const labelBytes = new Uint8Array(labelBitLen);
  let bitPos = 0;
  for (const c of labels) {
    const byteIdx = bitPos >> 3;
    const bitOff = bitPos & 7;
    labelBytes[byteIdx] |= (c << bitOff) & 0xff;
    if (bitOff > 3) labelBytes[byteIdx + 1] |= (c >> (8 - bitOff));
    bitPos += 5;
  }

  const header = Buffer.alloc(16);
  header.writeUInt32LE(words.length, 0);
  header.writeUInt32LE(structBits.length, 4);
  header.writeUInt32LE(labels.length, 8);
  header.writeUInt32LE(endBits.length, 12);

  const buf = Buffer.concat([header, structBytes, labelBytes, endBytes]);
  addRow("6a. LOUDS (struct+5bit labels+end)", new Uint8Array(buf));

  // 6b: LOUDS with byte labels instead of 5-bit
  const buf2 = Buffer.concat([header, structBytes, Buffer.from(labels), endBytes]);
  addRow("6b. LOUDS (struct+byte labels+end)", new Uint8Array(buf2));
}

// ═══════════════════════════════════════════════════════════════════════
// 7. HYBRID APPROACHES
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 7. HYBRID / NOVEL APPROACHES ===");

// 7a: DFS trie with Huffman-like variable-length char encoding
// More frequent edge labels get shorter codes
{
  // Count edge label frequencies
  const freq = new Array(26).fill(0);
  function countFreq(node: TrieNode) {
    for (const [ch, child] of node.children) {
      freq[ch]++;
      countFreq(child);
    }
  }
  countFreq(root);

  // Assign rank by frequency (most frequent = 0)
  const ranked = freq.map((f, i) => ({ ch: i, freq: f })).sort((a, b) => b.freq - a.freq);
  const charToRank = new Array(26);
  for (let i = 0; i < 26; i++) charToRank[ranked[i].ch] = i;

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  // Write the permutation table (26 bytes)
  for (let i = 0; i < 26; i++) buf.push(ranked[i].ch);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = charToRank[ch]; // more frequent chars -> lower values
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("7a. DFS trie + freq-ranked chars", new Uint8Array(buf));
}

// 7b: DFS trie but encode the isEnd flag only when needed
// Most nodes are NOT end-of-word. Use a separate bitstream for isEnd.
{
  const edgeBytes: number[] = [];
  const endBits: number[] = [];

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.children.size > 0) byte |= 0x20;
      if (i === keys.length - 1) byte |= 0x40;
      // Only 6 bits used, 2 spare
      edgeBytes.push(byte);
      endBits.push(child.isEnd ? 1 : 0);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);

  // Pack endBits
  const endPacked = new Uint8Array(Math.ceil(endBits.length / 8));
  for (let i = 0; i < endBits.length; i++) {
    if (endBits[i]) endPacked[i >> 3] |= (1 << (i & 7));
  }

  const header = Buffer.alloc(8);
  header.writeUInt32LE(words.length, 0);
  header.writeUInt32LE(edgeBytes.length, 4);
  const buf = Buffer.concat([header, Buffer.from(edgeBytes), endPacked]);
  addRow("7b. DFS trie: edges + separate endBits", new Uint8Array(buf));
}

// 7c: DFS trie with 2-bit flag encoding
// Observation: there are only 8 possible flag combos (isEnd x hasChild x isLast).
// Encode char(5) + flagCombo(3) but sort children by frequency of their flag combo.
// Actually, just try: since most edges have specific flag patterns,
// what if we use 2 separate bytes only when needed?
// Actually: let's try merging hasChildren and isLast into a single 2-bit field
// 00 = notLast, noChildren (impossible in sorted DFS? No, very common)
// 01 = notLast, hasChildren
// 10 = isLast, noChildren
// 11 = isLast, hasChildren
// So we have char(5) + isEnd(1) + combo(2) = 8 bits. Same as before but different bit layout.
// Let's try: upper 2 for combo, then isEnd, then 5 for char
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      const isLast = i === keys.length - 1;
      const hasChildren = child.children.size > 0;
      // byte layout: [combo:2][isEnd:1][char:5]
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (hasChildren) byte |= 0x40;
      if (isLast) byte |= 0x80;
      buf.push(byte);
      if (hasChildren) serialize(child);
    }
  }
  serialize(root);
  addRow("7c. DFS trie (same as std, verify)", new Uint8Array(buf));
}

// 7d: Elias-Fano / Rank-based DAWG
// Encode DAWG with node-indexed table, using sorted edge lists
// Each node: store edges as (char, targetId) where targetId is varint.
// Use topological sort so most references are forward (smaller varints).
{
  // Reuse DAWG from section 4
  const dawgSigs = new Map<string, number>(); // sig -> ID
  const dawgNodes = new Map<number, TrieNode>(); // ID -> canonical node
  const dawgNodeId = new Map<TrieNode, number>(); // node -> canonical ID
  let dawgNextId = 0;

  function computeSig2(node: TrieNode): string {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    const parts: string[] = [];
    for (const ch of keys) parts.push(`${ch}:${computeSig2(node.children.get(ch)!)}`);
    return (node.isEnd ? "1" : "0") + "[" + parts.join(",") + "]";
  }

  function assignIds2(node: TrieNode): number {
    const sig = computeSig2(node);
    const existing = dawgSigs.get(sig);
    if (existing !== undefined) {
      dawgNodeId.set(node, existing);
      return existing;
    }
    const id = dawgNextId++;
    dawgSigs.set(sig, id);
    dawgNodeId.set(node, id);
    dawgNodes.set(id, node);
    for (const ch of [...node.children.keys()].sort((a, b) => a - b)) {
      assignIds2(node.children.get(ch)!);
    }
    return id;
  }
  assignIds2(root);

  // Topological sort: reverse DFS post-order gives forward references
  const topoOrder: number[] = [];
  const visited = new Set<number>();
  function topoSort(id: number) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = dawgNodes.get(id)!;
    for (const [, child] of node.children) {
      topoSort(dawgNodeId.get(child)!);
    }
    topoOrder.push(id);
  }
  topoSort(dawgNodeId.get(root)!);
  topoOrder.reverse(); // now root is first, leaves are last

  // Remap IDs to topo order
  const topoRemap = new Map<number, number>();
  for (let i = 0; i < topoOrder.length; i++) topoRemap.set(topoOrder[i], i);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  buf.push(dawgNextId & 0xff, (dawgNextId >> 8) & 0xff, (dawgNextId >> 16) & 0xff, (dawgNextId >> 24) & 0xff);

  function writeVarint3(val: number) {
    while (val >= 0x80) {
      buf.push((val & 0x7f) | 0x80);
      val >>= 7;
    }
    buf.push(val);
  }

  for (const origId of topoOrder) {
    const node = dawgNodes.get(origId)!;
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    let header = keys.length;
    if (node.isEnd) header |= 0x80;
    buf.push(header);
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      const childId = topoRemap.get(dawgNodeId.get(child)!)!;
      buf.push(ch);
      writeVarint3(childId);
    }
  }
  addRow("7d. DAWG topo-sorted adjacency", new Uint8Array(buf));
}

// 7e: Patricia trie with DAWG-like suffix merging
// Build radix trie then compress equal subtrees
console.log("  (7e skipped - covered by DAWG approaches)");

// 7f: Entropy-coded DFS trie - store only the bits that vary
// Split: one bitstream for isEnd, one for isLast, one for hasChildren, one for chars
{
  const isEndBits: number[] = [];
  const isLastBits: number[] = [];
  const hasChildBits: number[] = [];
  const charVals: number[] = [];

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      charVals.push(ch);
      isEndBits.push(child.isEnd ? 1 : 0);
      hasChildBits.push(child.children.size > 0 ? 1 : 0);
      isLastBits.push(i === keys.length - 1 ? 1 : 0);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);

  function packBits2(bits: number[]): Uint8Array {
    const out = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) out[i >> 3] |= (1 << (i & 7));
    }
    return out;
  }

  const header = Buffer.alloc(8);
  header.writeUInt32LE(words.length, 0);
  header.writeUInt32LE(charVals.length, 4);

  // Each flag as separate bitstream
  const endPacked = packBits2(isEndBits);
  const lastPacked = packBits2(isLastBits);
  const childPacked = packBits2(hasChildBits);

  const buf = Buffer.concat([
    header,
    Buffer.from(charVals),
    endPacked,
    lastPacked,
    childPacked,
  ]);
  addRow("7f. 4-stream: chars + 3 bitstreams", new Uint8Array(buf));

  // 7g: Same but with 5-bit packed chars
  const charBitLen = Math.ceil(charVals.length * 5 / 8);
  const charBuf = new Uint8Array(charBitLen);
  let bp = 0;
  for (const c of charVals) {
    const byteIdx = bp >> 3;
    const bitOff = bp & 7;
    charBuf[byteIdx] |= (c << bitOff) & 0xff;
    if (bitOff > 3) charBuf[byteIdx + 1] |= (c >> (8 - bitOff));
    bp += 5;
  }
  const buf2 = Buffer.concat([header, charBuf, endPacked, lastPacked, childPacked]);
  addRow("7g. 4-stream: 5-bit chars + 3 bitstrms", new Uint8Array(buf2));
}

// 7h: Run-length encode the isEnd and hasChildren bitstreams (they're very skewed)
{
  const edgeBytes: number[] = [];

  // Collect raw edge data
  interface EdgeData { ch: number; isEnd: boolean; hasChildren: boolean; isLast: boolean; }
  const edges: EdgeData[] = [];

  function collectEdges(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      edges.push({
        ch,
        isEnd: child.isEnd,
        hasChildren: child.children.size > 0,
        isLast: i === keys.length - 1,
      });
      if (child.children.size > 0) collectEdges(child);
    }
  }
  collectEdges(root);

  // 7h: Combine hasChildren+isLast into 2 bits, pack with char
  // Then separate isEnd as RLE
  const mainStream: number[] = [];
  const endRLE: number[] = [];

  let runVal = false;
  let runLen = 0;

  for (const e of edges) {
    let byte = e.ch;
    if (e.hasChildren) byte |= 0x20;
    if (e.isLast) byte |= 0x40;
    mainStream.push(byte);

    if (e.isEnd === runVal) {
      runLen++;
    } else {
      if (runLen > 0) {
        // Write run: varint length
        let v = runLen;
        while (v >= 0x80) { endRLE.push((v & 0x7f) | 0x80); v >>= 7; }
        endRLE.push(v);
      }
      runVal = e.isEnd;
      runLen = 1;
    }
  }
  if (runLen > 0) {
    let v = runLen;
    while (v >= 0x80) { endRLE.push((v & 0x7f) | 0x80); v >>= 7; }
    endRLE.push(v);
  }

  const header = Buffer.alloc(12);
  header.writeUInt32LE(words.length, 0);
  header.writeUInt32LE(mainStream.length, 4);
  header.writeUInt32LE(endRLE.length, 8);
  const buf = Buffer.concat([header, Buffer.from(mainStream), Buffer.from(endRLE)]);
  addRow("7h. DFS edges + RLE isEnd", new Uint8Array(buf));
}

// 7i: Context-adaptive: for leaf nodes (no children), store only char+isEnd+isLast (3 flags in 3 bits)
// For internal nodes, store char+flags as usual. This way leaf bytes are in range 0-51 (fits in 6 bits)
// and internal bytes are 64-255. Two very distinct distributions -> better gzip.
// Actually we need isLast for both. Let's try: for nodes WITHOUT children (common case),
// merge the hasChildren=0 knowledge and use a smaller byte range.
{
  // This is essentially the same format but let's see if reversing bit order helps gzip
  // by clustering similar bytes together. Try: isLast in bit 0, hasChildren in bit 1, isEnd in bit 2, char in bits 3-7
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      // char in upper 5, flags in lower 3
      let byte = ch << 3;
      if (child.isEnd) byte |= 0x04;
      if (child.children.size > 0) byte |= 0x02;
      if (i === keys.length - 1) byte |= 0x01;
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  serialize(root);
  addRow("7i. DFS trie (char<<3 | flags)", new Uint8Array(buf));
}

// 7j: BFS trie - breadth-first serialization with child pointers
// This changes the access pattern - similar depth nodes are near each other
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // BFS: each node emits its children, then a "next" pointer isn't needed if we use isLast
  const queue: TrieNode[] = [root];
  // First pass: emit root's children
  let qi = 0;
  while (qi < queue.length) {
    const node = queue[qi++];
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      if (i === keys.length - 1) byte |= 0x80;
      buf.push(byte);
      if (child.children.size > 0) queue.push(child);
    }
  }
  addRow("7j. BFS trie (level-order)", new Uint8Array(buf));
}

// 7k: DFS trie with child-count + no isLast flag, ascending, frequency-reordered children
// Reorder children so most frequent edge labels come first within each node
{
  // Global edge frequency
  const edgeFreq = new Array(26).fill(0);
  function countEdgeFreq(node: TrieNode) {
    for (const [ch, child] of node.children) {
      edgeFreq[ch]++;
      countEdgeFreq(child);
    }
  }
  countEdgeFreq(root);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    // Sort children by frequency (most frequent first)
    const keys = [...node.children.keys()].sort((a, b) => edgeFreq[b] - edgeFreq[a]);
    buf.push(keys.length); // child count
    for (const ch of keys) {
      const child = node.children.get(ch)!;
      let byte = ch;
      if (child.isEnd) byte |= 0x20;
      if (child.children.size > 0) byte |= 0x40;
      buf.push(byte);
      if (child.children.size > 0) serialize(child);
    }
  }
  buf.push(root.children.size);
  const rootKeys = [...root.children.keys()].sort((a, b) => edgeFreq[b] - edgeFreq[a]);
  for (const ch of rootKeys) {
    const child = root.children.get(ch)!;
    let byte = ch;
    if (child.isEnd) byte |= 0x20;
    if (child.children.size > 0) byte |= 0x40;
    buf.push(byte);
    if (child.children.size > 0) serialize(child);
  }
  addRow("7k. DFS child-count + freq-ordered", new Uint8Array(buf));
}

// ═══════════════════════════════════════════════════════════════════════
// 8. DAWG with DFS + inline first / byte-offset backref (refined)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 8. REFINED DAWG APPROACHES ===");
{
  // Rebuild DAWG cleanly
  const sigs = new Map<string, string>();
  function sig(node: TrieNode): string {
    const cached = sigs.get(nodeKey(node));
    if (cached) return cached;
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    const s = (node.isEnd ? "1" : "0") + "[" + keys.map(ch => `${ch}:${sig(node.children.get(ch)!)}`).join(",") + "]";
    sigs.set(nodeKey(node), s);
    return s;
  }
  const nodeKeys = new Map<TrieNode, string>();
  let nk = 0;
  function nodeKey(n: TrieNode): string {
    let k = nodeKeys.get(n);
    if (!k) { k = String(nk++); nodeKeys.set(n, k); }
    return k;
  }

  // Map signature -> list of nodes with that signature
  const sigToNodes = new Map<string, TrieNode[]>();
  function buildSigMap(node: TrieNode) {
    const s = sig(node);
    let arr = sigToNodes.get(s);
    if (!arr) { arr = []; sigToNodes.set(s, arr); }
    arr.push(node);
    for (const child of node.children.values()) buildSigMap(child);
  }
  buildSigMap(root);

  // Pick canonical node per signature
  const canonMap = new Map<string, TrieNode>();
  for (const [s, nodes] of sigToNodes) canonMap.set(s, nodes[0]);

  const dawgSize = canonMap.size;
  console.log(`  DAWG unique subtrees: ${dawgSize}`);

  // 8a: DFS with byte-offset backrefs, BFS ordering for better locality
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    const inlinedSigs = new Set<string>();
    const sigOffset = new Map<string, number>();

    function writeVarint(val: number) {
      while (val >= 0x80) {
        buf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      buf.push(val);
    }

    function serialize(node: TrieNode) {
      const s = sig(node);
      const canon = canonMap.get(s)!;

      if (inlinedSigs.has(s)) {
        // backref
        buf.push(0x1f); // marker: char value 31 is never used (a-z = 0-25)
        const off = sigOffset.get(s)!;
        writeVarint(buf.length - off); // delta
        return;
      }

      inlinedSigs.add(s);
      sigOffset.set(s, buf.length);

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
    addRow("8a. DAWG DFS delta-backref (0x1f marker)", new Uint8Array(buf));
  }

  // 8b: DAWG serialized as compact table
  // Assign IDs 0..N-1 to unique subtrees in DFS order
  // Each node: [childCount | isEnd<<7] then for each child: [char, nodeId(varint)]
  {
    const orderedSigs: string[] = [];
    const sigId = new Map<string, number>();
    const visitedSigs = new Set<string>();

    function orderDFS(node: TrieNode) {
      const s = sig(node);
      if (visitedSigs.has(s)) return;
      visitedSigs.add(s);
      orderedSigs.push(s);
      sigId.set(s, orderedSigs.length - 1);
      const canon = canonMap.get(s)!;
      for (const ch of [...canon.children.keys()].sort((a, b) => a - b)) {
        orderDFS(canon.children.get(ch)!);
      }
    }
    orderDFS(root);

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(orderedSigs.length & 0xff, (orderedSigs.length >> 8) & 0xff,
             (orderedSigs.length >> 16) & 0xff, (orderedSigs.length >> 24) & 0xff);

    function writeVarint(val: number) {
      while (val >= 0x80) {
        buf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      buf.push(val);
    }

    for (const s of orderedSigs) {
      const canon = canonMap.get(s)!;
      const keys = [...canon.children.keys()].sort((a, b) => a - b);
      let header = keys.length;
      if (canon.isEnd) header |= 0x80;
      buf.push(header);
      for (const ch of keys) {
        const child = canon.children.get(ch)!;
        const childId = sigId.get(sig(child))!;
        buf.push(ch);
        writeVarint(childId);
      }
    }
    addRow("8b. DAWG table (DFS-ordered IDs)", new Uint8Array(buf));
  }

  // 8c: DAWG table with delta-encoded child IDs
  {
    const orderedSigs: string[] = [];
    const sigId2 = new Map<string, number>();
    const visitedSigs2 = new Set<string>();

    function orderDFS2(node: TrieNode) {
      const s = sig(node);
      if (visitedSigs2.has(s)) return;
      visitedSigs2.add(s);
      orderedSigs.push(s);
      sigId2.set(s, orderedSigs.length - 1);
      const canon = canonMap.get(s)!;
      for (const ch of [...canon.children.keys()].sort((a, b) => a - b)) {
        orderDFS2(canon.children.get(ch)!);
      }
    }
    orderDFS2(root);

    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    buf.push(orderedSigs.length & 0xff, (orderedSigs.length >> 8) & 0xff,
             (orderedSigs.length >> 16) & 0xff, (orderedSigs.length >> 24) & 0xff);

    function writeVarint(val: number) {
      while (val >= 0x80) {
        buf.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      buf.push(val);
    }

    for (let idx = 0; idx < orderedSigs.length; idx++) {
      const s = orderedSigs[idx];
      const canon = canonMap.get(s)!;
      const keys = [...canon.children.keys()].sort((a, b) => a - b);
      let header = keys.length;
      if (canon.isEnd) header |= 0x80;
      buf.push(header);
      let prevId = idx; // delta from current node ID
      for (const ch of keys) {
        const child = canon.children.get(ch)!;
        const childId = sigId2.get(sig(child))!;
        buf.push(ch);
        // Delta from previous (could be negative, so use zigzag)
        const delta = childId - prevId;
        const zigzag = (delta << 1) ^ (delta >> 31);
        writeVarint(zigzag);
        prevId = childId;
      }
    }
    addRow("8c. DAWG table (delta+zigzag IDs)", new Uint8Array(buf));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 9. Patricia DAWG (radix trie with shared suffixes)
// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== 9. PATRICIA DAWG ===");
{
  // Build radix trie
  interface RNode {
    label: number[];
    isEnd: boolean;
    children: Map<number, RNode>;
  }

  function buildRadix2(trie: TrieNode): RNode {
    const rn: RNode = { label: [], isEnd: trie.isEnd, children: new Map() };
    for (const [ch, child] of trie.children) {
      const label = [ch];
      let cur = child;
      while (cur.children.size === 1 && !cur.isEnd) {
        const [nextCh, nextChild] = [...cur.children.entries()][0];
        label.push(nextCh);
        cur = nextChild;
      }
      const rChild = buildRadix2(cur);
      rChild.label = label;
      rChild.isEnd = cur.isEnd;
      rn.children.set(ch, rChild);
    }
    return rn;
  }

  const radixRoot = buildRadix2(root);

  // Compute signatures for radix nodes
  const rsigs = new Map<RNode, string>();
  function rsig(node: RNode): string {
    const cached = rsigs.get(node);
    if (cached) return cached;
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    const s = (node.isEnd ? "1" : "0") + "{" + node.label.join(".") + "}" +
      "[" + keys.map(ch => `${ch}:${rsig(node.children.get(ch)!)}`).join(",") + "]";
    rsigs.set(node, s);
    return s;
  }

  // Count unique subtrees
  const uniqueRadix = new Set<string>();
  function countUnique(node: RNode) {
    uniqueRadix.add(rsig(node));
    for (const child of node.children.values()) countUnique(child);
  }
  countUnique(radixRoot);
  console.log(`  Unique radix subtrees: ${uniqueRadix.size}`);

  // DFS serialize radix trie (no DAWG dedup, just path compression)
  {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    function serialize(node: RNode) {
      const keys = [...node.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const child = node.children.get(keys[i])!;
        const label = child.label;
        // First byte: first char + flags
        let byte = label[0];
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
        buf.push(byte);
        // If label > 1 char, use continuation bytes (char | 0x20 for "more" flag? no)
        // Use simple encoding: label length - 1 then remaining chars
        if (label.length > 1) {
          // Encode remaining label chars with a length prefix
          buf.push(label.length - 1);
          for (let j = 1; j < label.length; j++) buf.push(label[j]);
        }
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(radixRoot);
    addRow("9a. Patricia DFS (first char in flags)", new Uint8Array(buf));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FINAL TABLE
// ═══════════════════════════════════════════════════════════════════════
console.log("\n");
console.log("=".repeat(80));
console.log("                        ITERATION 2 COMPARISON TABLE");
console.log("=".repeat(80));
console.log("");

const baseline = rows.find(r => r.name.includes("baseline"))!;
const prevBest = rows.find(r => r.name.includes("prev best"))!;

console.log(
  "  " +
  "Approach".padEnd(44) +
  "Raw KB".padStart(8) +
  "  GZ KB".padStart(8) +
  "  vs prev".padStart(10) +
  "  vs text".padStart(10)
);
console.log("  " + "-".repeat(80));

rows.sort((a, b) => a.gz - b.gz);
for (const r of rows) {
  const rawKB = (r.raw / 1024).toFixed(0);
  const gzKB = (r.gz / 1024).toFixed(0);
  const vsPrev = ((r.gz / prevBest.gz) * 100).toFixed(1) + "%";
  const vsText = ((r.gz / baseline.gz) * 100).toFixed(1) + "%";
  const marker = r.gz < prevBest.gz ? " <<<" : "";
  console.log(
    "  " +
    r.name.padEnd(44).slice(0, 44) +
    rawKB.padStart(8) +
    gzKB.padStart(8) +
    vsPrev.padStart(10) +
    vsText.padStart(10) +
    marker
  );
}

console.log("\n" + "=".repeat(80));
const best = rows[0];
if (best.gz < prevBest.gz) {
  console.log(`\nNEW BEST: ${best.name}`);
  console.log(`  Raw: ${(best.raw / 1024).toFixed(0)} KB, Gzipped: ${(best.gz / 1024).toFixed(0)} KB`);
  console.log(`  Improvement over DFS trie standard: ${(prevBest.gz - best.gz)} bytes (${((1 - best.gz/prevBest.gz)*100).toFixed(1)}%)`);
  console.log(`  Improvement over raw text gz: ${(baseline.gz - best.gz)} bytes (${((1 - best.gz/baseline.gz)*100).toFixed(1)}%)`);
} else {
  console.log(`\nNo improvement found. Previous best (DFS trie standard) remains at ${(prevBest.gz / 1024).toFixed(0)} KB gzipped.`);
}
