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

interface Result { name: string; rawBytes: number; gzBytes: number; }
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
    if (!child) { child = { children: new Map(), isEnd: false }; node.children.set(ch, child); }
    node = child;
  }
  node.isEnd = true;
}

// ─── Encode DFS trie with configurable options ───────────────────
function encodeTrie(opts: {
  sortOrder: "asc" | "desc" | "freq";
  charBits: "lower5" | "upper5";
  flagLayout: "standard" | "alt1";
}): Uint8Array {
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // Cache subtree sizes for freq ordering
  const sizeCache = new Map<TrieNode, number>();
  function cachedSize(node: TrieNode): number {
    let s = sizeCache.get(node);
    if (s !== undefined) return s;
    s = 1;
    for (const child of node.children.values()) s += cachedSize(child);
    sizeCache.set(node, s);
    return s;
  }

  function serialize(node: TrieNode) {
    let keys = [...node.children.keys()];
    if (opts.sortOrder === "asc") keys.sort((a, b) => a - b);
    else if (opts.sortOrder === "desc") keys.sort((a, b) => b - a);
    else keys.sort((a, b) => cachedSize(node.children.get(b)!) - cachedSize(node.children.get(a)!));

    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte: number;
      if (opts.charBits === "lower5") {
        byte = ch;
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
      } else {
        // upper 5 bits for char
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

// Test all combinations
for (const sortOrder of ["asc", "desc", "freq"] as const) {
  for (const charBits of ["lower5", "upper5"] as const) {
    const data = encodeTrie({ sortOrder, charBits, flagLayout: "standard" });
    measure(`sort=${sortOrder}, char=${charBits}`, data);
  }
}

// ─── Verify reverse-sorted decoder works ─────────────────────────
{
  const data = encodeTrie({ sortOrder: "desc", charBits: "lower5", flagLayout: "standard" });
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(0, true);
  const decoded: string[] = [];
  let pos = 4;
  const stack: number[] = [];

  function decode() {
    while (pos < data.length) {
      const b = data[pos++];
      stack.push((b & 0x1f) + 97);
      if (b & 0x20) decoded.push(String.fromCharCode(...stack));
      if (b & 0x40) decode();
      stack.pop();
      if (b & 0x80) return;
    }
  }
  decode();

  // The words come out in reverse-sorted order per trie level, so we need to sort
  decoded.sort();
  if (decoded.length !== words.length) {
    console.error(`Reverse FAIL: expected ${words.length}, got ${decoded.length}`);
  } else {
    let ok = true;
    for (let i = 0; i < words.length; i++) {
      if (decoded[i] !== words[i]) {
        console.error(`Reverse FAIL at ${i}: expected "${words[i]}", got "${decoded[i]}"`);
        ok = false;
        break;
      }
    }
    if (ok) console.log("Reverse-sorted trie decoder: roundtrip OK");
  }
}

// ─── Also try: interleaving forward and reverse subtrees ─────────
// For each node, sort children: put the most common letter first (for gzip repetition)
// Actually, let's just try all 26 rotations of the alphabet to see if any beats desc
{
  console.log("\n─── Alphabet rotation experiments ───");
  let bestRot = 0, bestGz = Infinity;
  for (let rot = 0; rot < 26; rot++) {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    function serialize(node: TrieNode) {
      // Sort by (char + rot) % 26, ascending -- effectively shifts what "ascending" means
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

    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 });
    if (rot < 5 || gz.length < bestGz || rot === 13 || rot === 25) {
      console.log(`  rot ${rot.toString().padStart(2)}: ${(gz.length / 1024).toFixed(0)} KB`);
    }
    if (gz.length < bestGz) { bestGz = gz.length; bestRot = rot; }
  }
  console.log(`  Best rotation: ${bestRot} at ${(bestGz / 1024).toFixed(0)} KB`);
}

// ─── Try: XOR the char values with a constant ───
{
  console.log("\n─── XOR experiments ───");
  for (const xorVal of [0, 5, 10, 13, 15, 20, 25]) {
    const buf: number[] = [];
    const n = words.length;
    buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

    function serialize(node: TrieNode) {
      const keys = [...node.children.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i] ^ xorVal; // XOR to spread byte values
        const child = node.children.get(keys[i])!;
        let byte = ch & 0x1f;
        if (child.isEnd) byte |= 0x20;
        if (child.children.size > 0) byte |= 0x40;
        if (i === keys.length - 1) byte |= 0x80;
        buf.push(byte);
        if (child.children.size > 0) serialize(child);
      }
    }
    serialize(root);
    const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 });
    console.log(`  XOR ${xorVal.toString().padStart(2)}: ${(gz.length / 1024).toFixed(0)} KB`);
  }
}

// ─── The ultimate test: combine desc sort with brotli ───
{
  const { brotliCompressSync, constants } = await import("node:zlib");
  const descData = encodeTrie({ sortOrder: "desc", charBits: "lower5", flagLayout: "standard" });
  const ascData = encodeTrie({ sortOrder: "asc", charBits: "lower5", flagLayout: "standard" });

  const brDesc = brotliCompressSync(Buffer.from(descData), {
    params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
  });
  const brAsc = brotliCompressSync(Buffer.from(ascData), {
    params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
  });

  console.log(`\n─── Brotli comparison ───`);
  console.log(`  Asc trie + brotli: ${(brAsc.length / 1024).toFixed(0)} KB`);
  console.log(`  Desc trie + brotli: ${(brDesc.length / 1024).toFixed(0)} KB`);
  console.log(`  Asc trie + gzip: ${(gzipSync(Buffer.from(ascData), { level: 9 }).length / 1024).toFixed(0)} KB`);
  console.log(`  Desc trie + gzip: ${(gzipSync(Buffer.from(descData), { level: 9 }).length / 1024).toFixed(0)} KB`);
}

// ─── Print final results ─────────────────────────────────────────
console.log("\n═══ FINAL COMPARISON ═══\n");
console.log(
  "│ " + "Approach".padEnd(40) + " │ " + "Raw KB".padStart(8) + " │ " + "GZ KB".padStart(8) + " │"
);
console.log("│" + "─".repeat(42) + "│" + "─".repeat(10) + "│" + "─".repeat(10) + "│");
const sorted = [...results].sort((a, b) => a.gzBytes - b.gzBytes);
for (const r of sorted) {
  console.log(
    "│ " + r.name.padEnd(40).slice(0, 40) + " │ " +
    (r.rawBytes / 1024).toFixed(0).padStart(8) + " │ " +
    (r.gzBytes / 1024).toFixed(0).padStart(8) + " │"
  );
}
