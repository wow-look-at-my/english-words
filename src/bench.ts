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

console.log(`Loaded ${words.length} words, raw text ${text.length} bytes`);

// ─── PART 1: Statistics ──────────────────────────────────────────────

// 1a. Prefix sharing stats for globally-sorted front-coding
{
  console.log("\n═══ PART 1: STATISTICS ═══\n");

  // Length distribution
  const lenDist = new Map<number, number>();
  for (const w of words) {
    lenDist.set(w.length, (lenDist.get(w.length) ?? 0) + 1);
  }
  console.log("─── Word length distribution ───");
  const sortedLens = [...lenDist.entries()].sort((a, b) => a[0] - b[0]);
  for (const [len, count] of sortedLens) {
    console.log(`  len ${String(len).padStart(2)}: ${String(count).padStart(6)} words`);
  }

  // Prefix sharing stats (globally sorted)
  const sharedLens: number[] = [];
  const suffixLens: number[] = [];
  const suffixChars: number[] = new Array(26).fill(0);
  let totalSuffixBytes = 0;
  let totalShared = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = i > 0 ? words[i - 1] : "";
    let shared = 0;
    while (shared < prev.length && shared < w.length && prev[shared] === w[shared]) {
      shared++;
    }
    const suffLen = w.length - shared;
    sharedLens.push(shared);
    suffixLens.push(suffLen);
    totalShared += shared;
    totalSuffixBytes += suffLen;
    for (let j = shared; j < w.length; j++) {
      suffixChars[w.charCodeAt(j) - 97]++;
    }
  }

  console.log("\n─── Global front-coding prefix share distribution ───");
  const shareDist = new Map<number, number>();
  for (const s of sharedLens) shareDist.set(s, (shareDist.get(s) ?? 0) + 1);
  const sortedShares = [...shareDist.entries()].sort((a, b) => a[0] - b[0]);
  for (const [len, count] of sortedShares) {
    console.log(`  shared ${String(len).padStart(2)}: ${String(count).padStart(6)} (${((count / words.length) * 100).toFixed(1)}%)`);
  }
  console.log(`  avg shared: ${(totalShared / words.length).toFixed(2)}`);
  console.log(`  avg suffix:  ${(totalSuffixBytes / words.length).toFixed(2)}`);
  console.log(`  total suffix bytes: ${totalSuffixBytes}`);

  // Suffix length distribution
  console.log("\n─── Suffix length distribution ───");
  const suffDist = new Map<number, number>();
  for (const s of suffixLens) suffDist.set(s, (suffDist.get(s) ?? 0) + 1);
  const sortedSuffs = [...suffDist.entries()].sort((a, b) => a[0] - b[0]);
  for (const [len, count] of sortedSuffs) {
    console.log(`  suffix ${String(len).padStart(2)}: ${String(count).padStart(6)} (${((count / words.length) * 100).toFixed(1)}%)`);
  }

  // Character frequency in suffixes
  console.log("\n─── Character frequency in suffixes (after front-coding) ───");
  const charEntries = Array.from({ length: 26 }, (_, i) => ({
    ch: String.fromCharCode(97 + i),
    count: suffixChars[i],
  })).sort((a, b) => b.count - a.count);
  for (const { ch, count } of charEntries) {
    const pct = ((count / totalSuffixBytes) * 100).toFixed(2);
    console.log(`  ${ch}: ${String(count).padStart(7)} (${pct}%)`);
  }

  // Entropy calculation
  let entropy = 0;
  for (const { count } of charEntries) {
    if (count === 0) continue;
    const p = count / totalSuffixBytes;
    entropy -= p * Math.log2(p);
  }
  console.log(`\n  Entropy of suffix chars: ${entropy.toFixed(3)} bits/char`);
  console.log(`  Theoretical min: ${(entropy * totalSuffixBytes / 8).toFixed(0)} bytes for suffix data`);

  // Prefix share field: how many bits needed?
  let maxShare = 0;
  for (const s of sharedLens) if (s > maxShare) maxShare = s;
  console.log(`\n  Max prefix_share value: ${maxShare}`);
  console.log(`  Bits for prefix_share (fixed): ${Math.ceil(Math.log2(maxShare + 1))}`);

  // How many prefix_share values fit in various ranges
  let countLE7 = 0, countLE15 = 0, countLE31 = 0;
  for (const s of sharedLens) {
    if (s <= 7) countLE7++;
    if (s <= 15) countLE15++;
    if (s <= 31) countLE31++;
  }
  console.log(`  prefix_share <= 7:  ${countLE7} (${((countLE7 / words.length) * 100).toFixed(1)}%)`);
  console.log(`  prefix_share <= 15: ${countLE15} (${((countLE15 / words.length) * 100).toFixed(1)}%)`);
  console.log(`  prefix_share <= 31: ${countLE31} (${((countLE31 / words.length) * 100).toFixed(1)}%)`);
}

// ─── PART 2: Encoding benchmarks ─────────────────────────────────────

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

// Helper: compute shared prefix length
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// ─── Baseline: raw text gzipped ────────────────────────────────────
{
  const textBytes = new TextEncoder().encode(words.join("\n") + "\n");
  measure("A. Raw text (\\n separated)", textBytes);
}

// ─── B. Global front-coded, byte-level (prefix_share:u8 + suffix_len:u8 + suffix bytes) ───
{
  const buf: number[] = [];
  // Simple header: word count as u32le
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    buf.push(shared);    // u8: prefix_share
    buf.push(suffLen);   // u8: suffix_len
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97); // 0-25
    }
    prev = w;
  }
  measure("B. Global front-coded (u8 share + u8 sufflen + suffix bytes)", new Uint8Array(buf));
}

// ─── C. Global front-coded, varint prefix_share ──────────────────────
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    // Varint for prefix_share
    let v = shared;
    while (v >= 0x80) {
      buf.push((v & 0x7f) | 0x80);
      v >>= 7;
    }
    buf.push(v);
    // Varint for suffix_len
    v = suffLen;
    while (v >= 0x80) {
      buf.push((v & 0x7f) | 0x80);
      v >>= 7;
    }
    buf.push(v);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("C. Global front-coded (varint share + varint sufflen + suffix)", new Uint8Array(buf));
}

// ─── D. Global front-coded, no suffix_len (use terminator 31) ─────────
{
  // Suffix chars are 0-25 (a-z). Use 31 as end-of-word marker.
  // prefix_share as u8, then suffix chars (0-25), then 31 terminator.
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    buf.push(31); // terminator
    prev = w;
  }
  measure("D. Global front-coded (u8 share + suffix + terminator 31)", new Uint8Array(buf));
}

// ─── E. Global front-coded, single-byte encoding: high bit = "new suffix starts", remaining = char or share ─────
{
  // Pack prefix_share and suffix into a stream where each byte has flag bits.
  // Approach: prefix_share as u8, then suffix_len as u8, suffix chars stored as 0-25.
  // But try: interleave prefix_share into the char stream.
  // Use byte value: 0-25 = suffix char, 26 = separator (start new word), 27-255 = prefix_share - 1 (so 27 = share 0, 28 = share 1, etc.)
  // Wait, that's clever: after separator, next byte is always prefix_share.
  // Actually simpler: just use 0-25 for chars, and every word starts with its prefix_share value + 26.
  // So byte 26 = share 0, byte 27 = share 1, ..., byte 26+N = share N.
  // Max share is ~30, so this fits in a byte.
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared + 26); // 26+ = prefix share marker
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97); // 0-25
    }
    prev = w;
  }
  measure("E. Global front-coded (share+26 marker + suffix, no len/term)", new Uint8Array(buf));
}

// ─── F. Delta-coded chars: store difference from previous word's corresponding char ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    buf.push(shared);
    buf.push(suffLen);

    // For suffix chars, delta-encode against previous word's chars at same position (if they exist)
    for (let i = shared; i < w.length; i++) {
      const cur = w.charCodeAt(i) - 97;
      if (i < prev.length) {
        const prevCh = prev.charCodeAt(i) - 97;
        buf.push(((cur - prevCh + 26) % 26) & 0xff); // delta mod 26
      } else {
        buf.push(cur); // no previous char at this position, store absolute
      }
    }
    prev = w;
  }
  measure("F. Global front-coded + delta chars (mod 26)", new Uint8Array(buf));
}

// ─── G. Global front-coded with nibble-packed prefix_share (4 bits, overflow to next byte) ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    // Pack shared into 4 bits. If >= 15, use 15 + overflow byte.
    if (shared < 15) {
      buf.push((shared << 4) | (suffLen < 15 ? suffLen : 15));
    } else {
      buf.push((15 << 4) | (suffLen < 15 ? suffLen : 15));
      buf.push(shared); // overflow
    }
    if (suffLen >= 15) {
      buf.push(suffLen); // overflow
    }
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("G. Global front-coded (nibble-packed share+sufflen + suffix)", new Uint8Array(buf));
}

// ─── H. Global front-coded, suffix_len omitted (derive from next word's prefix_share) ───
// Not possible without buffering. Skip.

// ─── I. Trie-based: store trie edges DFS, with end-of-word markers ───
{
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

  // Serialize trie as DFS: for each node, output sorted children.
  // Each child: char (5 bits worth, stored as byte 0-25), flags (isEnd, hasChildren).
  // Use: byte = char | (isEnd ? 0x20 : 0) | (hasChildren ? 0x40 : 0) | (isLastChild ? 0x80 : 0)
  const trieBuf: number[] = [];
  const n = words.length;
  trieBuf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serializeNode(node: TrieNode) {
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte = ch; // 0-25
      if (child.isEnd) byte |= 0x20;        // bit 5: end of word
      if (child.children.size > 0) byte |= 0x40; // bit 6: has children
      if (i === keys.length - 1) byte |= 0x80;   // bit 7: last child
      trieBuf.push(byte);
      if (child.children.size > 0) {
        serializeNode(child);
      }
    }
  }
  serializeNode(root);
  measure("I. DFS trie (char|flags byte per edge)", new Uint8Array(trieBuf));
}

// ─── J. DAWG-like: trie with suffix sharing via hashing ───
// Full DAWG is complex but let's try a simple approach: right-minimized trie
{
  // Build trie
  interface TNode {
    children: Map<number, TNode>;
    isEnd: boolean;
    id: number;
  }
  let nextId = 0;

  function makeNode(): TNode {
    return { children: new Map(), isEnd: false, id: nextId++ };
  }

  const root = makeNode();
  for (const w of words) {
    let node = root;
    for (let i = 0; i < w.length; i++) {
      const ch = w.charCodeAt(i) - 97;
      let child = node.children.get(ch);
      if (!child) {
        child = makeNode();
        node.children.set(ch, child);
      }
      node = child;
    }
    node.isEnd = true;
  }

  // Minimize: hash subtrees bottom-up, merge identical
  function hashNode(node: TNode): string {
    const parts: string[] = [node.isEnd ? "1" : "0"];
    const keys = [...node.children.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      parts.push(`${k}:${hashNode(node.children.get(k)!)}`);
    }
    return parts.join(",");
  }

  // Count unique subtrees
  const hashes = new Set<string>();
  function countUnique(node: TNode) {
    hashes.add(hashNode(node));
    for (const child of node.children.values()) {
      countUnique(child);
    }
  }
  // This is O(n^2) in the worst case, let's just count trie nodes instead
  let totalNodes = 0;
  function countNodes(node: TNode) {
    totalNodes++;
    for (const child of node.children.values()) {
      countNodes(child);
    }
  }
  countNodes(root);
  console.log(`\n─── Trie stats ───`);
  console.log(`  Total trie nodes: ${totalNodes}`);

  // Count total edges
  let totalEdges = 0;
  function countEdges(node: TNode) {
    totalEdges += node.children.size;
    for (const child of node.children.values()) {
      countEdges(child);
    }
  }
  countEdges(root);
  console.log(`  Total trie edges: ${totalEdges}`);
}

// ─── K. Length-grouped, globally sorted front-coded within each group ───
{
  const groups = new Map<number, string[]>();
  for (const w of words) {
    let g = groups.get(w.length);
    if (!g) { g = []; groups.set(w.length, g); }
    g.push(w);
  }
  for (const g of groups.values()) g.sort();

  const buf: number[] = [];
  const maxLen = Math.max(...groups.keys());
  // Header
  buf.push(maxLen);
  for (let i = 1; i <= maxLen; i++) {
    const c = groups.get(i)?.length ?? 0;
    buf.push(c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, (c >> 24) & 0xff);
  }
  // Body
  for (let len = 1; len <= maxLen; len++) {
    const g = groups.get(len);
    if (!g) continue;
    let prev = "";
    for (const w of g) {
      const shared = sharedPrefix(prev, w);
      buf.push(shared);
      for (let i = shared; i < w.length; i++) {
        buf.push(w.charCodeAt(i) - 97);
      }
      prev = w;
    }
  }
  measure("K. Length-grouped front-coded (existing v2 format)", new Uint8Array(buf));
}

// ─── L. Global front-coded, suffix chars stored as raw ASCII (97-122) instead of 0-25 ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    buf.push(shared);
    buf.push(suffLen);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i)); // raw ASCII 97-122
    }
    prev = w;
  }
  measure("L. Global front-coded (u8 share + u8 sufflen + ASCII suffix)", new Uint8Array(buf));
}

// ─── M. Global front-coded, interleaved: share byte combined with first suffix char ───
{
  // Observation: suffix always has at least 1 char (except for duplicate words, which don't exist).
  // Encode: first byte = shared * 26 + first_suffix_char (if shared <= 9, max first byte = 9*26+25 = 259 > 255... doesn't fit for all)
  // Alternative: use 5 bits for first char (0-25), 3 bits for share (0-7), then overflow byte if share > 7
  // Byte 0: (share_low3 << 5) | first_suffix_char   -- 8 bits total
  // If share >= 8: next byte = full share value
  // Then remaining suffix chars (0-25)
  // Then suffix_len... we still need that. Use terminator.
  // Actually: byte 0 = (min(share,7) << 5) | first_suffix_char
  // If share >= 8: next byte = share
  // Remaining suffix chars, then terminator (31? or 0x1F won't conflict since chars are 0-25...
  // but 0x1F = 31 which doesn't appear in suffix or share. Let's use a scheme:
  // After byte 0 and optional share overflow, we know first char.
  // Then remaining suffix chars (0-25), terminated by value 27.
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    const firstChar = w.charCodeAt(shared) - 97;
    const shareLow = Math.min(shared, 7);
    buf.push((shareLow << 5) | firstChar);
    if (shared >= 8) buf.push(shared);
    // Remaining suffix chars
    for (let i = shared + 1; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    buf.push(27); // terminator
    prev = w;
  }
  measure("M. Global front-coded (packed first byte + suffix + terminator)", new Uint8Array(buf));
}

// ─── N. Global front-coded, share byte embedded as 26+ (approach E) but with RLE for repeated share values ───
// Actually, let's try something different:

// ─── N. Global front-coded with combined share+sufflen in one byte ───
{
  // Most share values are 0-15, most suffix lengths are 1-15.
  // Encode as single byte: high nibble = min(share, 15), low nibble = min(suffLen, 15)
  // Overflow bytes if needed.
  // This saves 1 byte per word vs approach B when both fit in 4 bits.
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    const sh = Math.min(shared, 15);
    const sl = Math.min(suffLen, 15);
    buf.push((sh << 4) | sl);
    if (shared >= 15) buf.push(shared);
    if (suffLen >= 15) buf.push(suffLen);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("N. Global front-coded (nibble share|sufflen + suffix)", new Uint8Array(buf));
}

// ─── O. Approach E (share+26 marker) with suffix chars stored as ASCII ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared + 26);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i)); // ASCII 97-122
    }
    prev = w;
  }
  measure("O. Global front-coded (share+26 marker + ASCII suffix)", new Uint8Array(buf));
}

// ─── P. Approach B but with XOR-based suffix: each suffix char XORed with position-based prediction ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    buf.push(shared);
    buf.push(suffLen);
    // For the first suffix char: since words are sorted, the first differing char
    // is >= the previous word's char at that position. Store the delta.
    for (let i = shared; i < w.length; i++) {
      const cur = w.charCodeAt(i) - 97;
      if (i === shared && i < prev.length) {
        // First differing position: cur >= prev[i] (since sorted)
        const prevCh = prev.charCodeAt(i) - 97;
        buf.push(cur - prevCh); // always >= 0 since sorted, and <= 25
      } else if (i < prev.length) {
        // Subsequent positions after the first diff: could be anything
        buf.push(cur);
      } else {
        buf.push(cur);
      }
    }
    prev = w;
  }
  measure("P. Global front-coded + delta first suffix char", new Uint8Array(buf));
}

// ─── Q. Approach B but group consecutive words with same prefix_share value ───
{
  // Run-length encode the prefix_share values, then store suffix data separately
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // First pass: collect all (shared, suffLen, suffix) tuples
  const entries: { shared: number; suffLen: number; suffix: number[] }[] = [];
  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    const suffix: number[] = [];
    for (let i = shared; i < w.length; i++) {
      suffix.push(w.charCodeAt(i) - 97);
    }
    entries.push({ shared, suffLen, suffix });
    prev = w;
  }

  // Interleaved: for each word, store shared:u8, suffLen:u8, then suffix
  // But try: separate streams for metadata vs suffix data, concatenated
  // Stream 1: all shared values (u8 each)
  // Stream 2: all suffLen values (u8 each)
  // Stream 3: all suffix chars concatenated
  const sharedStream: number[] = [];
  const suffLenStream: number[] = [];
  const charStream: number[] = [];
  for (const e of entries) {
    sharedStream.push(e.shared);
    suffLenStream.push(e.suffLen);
    charStream.push(...e.suffix);
  }

  // Store lengths of each stream
  const s1Len = sharedStream.length;
  const s2Len = suffLenStream.length;
  buf.push(s1Len & 0xff, (s1Len >> 8) & 0xff, (s1Len >> 16) & 0xff, (s1Len >> 24) & 0xff);
  buf.push(s2Len & 0xff, (s2Len >> 8) & 0xff, (s2Len >> 16) & 0xff, (s2Len >> 24) & 0xff);
  for (const v of sharedStream) buf.push(v);
  for (const v of suffLenStream) buf.push(v);
  for (const v of charStream) buf.push(v);
  measure("Q. Global front-coded, split streams (share|sufflen|chars)", new Uint8Array(buf));
}

// ─── R. Approach E (share+26, no len/terminator) with delta on first suffix char ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared + 26); // marker byte
    // First suffix char: delta from prev
    if (shared < prev.length) {
      const delta = (w.charCodeAt(shared) - 97) - (prev.charCodeAt(shared) - 97);
      buf.push(delta); // 0-25 range since sorted
    } else {
      buf.push(w.charCodeAt(shared) - 97);
    }
    // Rest of suffix chars: absolute
    for (let i = shared + 1; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("R. Global front-coded (share+26 + delta first char + suffix)", new Uint8Array(buf));
}

// ─── S. Approach E with bit-level delta on ALL suffix chars vs prev word ───
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared + 26);
    for (let i = shared; i < w.length; i++) {
      const cur = w.charCodeAt(i) - 97;
      if (i < prev.length) {
        buf.push(((cur - (prev.charCodeAt(i) - 97)) + 26) % 26);
      } else {
        buf.push(cur);
      }
    }
    prev = w;
  }
  measure("S. Global front-coded (share+26 + delta ALL suffix chars)", new Uint8Array(buf));
}

// ─── T. Approach E but with chars as 1-26 instead of 0-25 (so share marker 0 = share 0) ───
// This makes the stream use values 0-26 for share, 1-26 for chars.
// Actually let's try: use 0 as word separator, chars are 1-26, prefix_share is stored after separator.
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  let first = true;
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    if (!first) buf.push(0); // word separator
    buf.push(shared + 1); // 1-based share (1 = share 0)
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 96); // 1-26 for a-z
    }
    prev = w;
    first = false;
  }
  measure("T. Global front-coded (0-sep + 1-based share + 1-26 chars)", new Uint8Array(buf));
}

// ─── U. Succinct trie attempt: LOUDS-based encoding ───
// Skip this for now as it's complex and typically doesn't gzip well.

// ─── V. Global front-coded with Huffman-like byte codes for common suffixes ───
// Too complex. Let's try something simpler:

// ─── V. Approach B but interleaving share and first suffix char into one byte ───
{
  // Since share is 0-31 (5 bits) and chars are 0-25 (5 bits), we can't fit both in one byte
  // But share < 8 covers 87% of cases. So: if share < 8: byte = share*26 + first_char (0-207)
  // Else: byte = 208 + (share - 8) as escape, then first_char as separate byte
  // Wait: 8*26 = 208, plus 25 = 233 max for compact case. For share >= 8: use 234 as escape, then share byte, then char.
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const suffLen = w.length - shared;
    const firstChar = w.charCodeAt(shared) - 97;

    if (shared < 9) {
      buf.push(shared * 26 + firstChar); // 0-233
      buf.push(suffLen);
    } else {
      buf.push(234); // escape
      buf.push(shared);
      buf.push(firstChar);
      buf.push(suffLen);
    }
    for (let i = shared + 1; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("V. Global front-coded (combined share*26+char byte + sufflen)", new Uint8Array(buf));
}

// ─── W. Store only the trie structure: DAFSA (minimal acyclic finite-state automaton) ───
// Full DAFSA is complex. Let's instead try the approach E variant that empirically won,
// but with chars stored as bytes in range 128-153 (high bit set) and share as 0-63 (no high bit).
// This creates a self-synchronizing stream: share bytes always have bit 7 = 0, char bytes always have bit 7 = 1.
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared); // 0-63, bit 7 = 0
    for (let i = shared; i < w.length; i++) {
      buf.push((w.charCodeAt(i) - 97) | 0x80); // 128-153, bit 7 = 1
    }
    prev = w;
  }
  measure("W. Global front-coded (share:0-63 + chars:128-153, self-sync)", new Uint8Array(buf));
}

// ─── X. Approach E with newline as terminator (pure text-like) ───
{
  // Use printable ASCII: share encoded as printable char, suffix as lowercase letters
  // share 0 = 'A', share 1 = 'B', ..., share 25 = 'Z', share 26 = '[', etc.
  // Suffix chars are lowercase a-z. Separated by newlines.
  // This is essentially text that gzip can treat like text.
  const lines: string[] = [];
  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    const shareChar = String.fromCharCode(65 + shared); // A=0, B=1, ...
    const suffix = w.slice(shared);
    lines.push(shareChar + suffix);
    prev = w;
  }
  const textData = new TextEncoder().encode(lines.join("\n") + "\n");
  measure("X. Global front-coded as text (share-char + suffix + newline)", textData);
}

// ─── Y. Like X but more compact: share as digit char, suffix as lowercase ───
// Already covered by X essentially.

// ─── Z. Global front-coded, approach E (share+26), with byte-pair encoded common suffixes ───
// Too complex for ~100 lines. Skip.

// ─── AA. Combined best ideas: approach E (share+26 marker, no length/terminator) with gzip ───
// Already done as E. Let's also try the variant where we split into blocks of 256 words
// and reset the prefix coding at each block boundary. This gives gzip better patterns.
{
  const BLOCK = 256;
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  for (let start = 0; start < words.length; start += BLOCK) {
    const end = Math.min(start + BLOCK, words.length);
    let prev = "";
    for (let i = start; i < end; i++) {
      const w = words[i];
      const shared = sharedPrefix(prev, w);
      buf.push(shared + 26);
      for (let j = shared; j < w.length; j++) {
        buf.push(w.charCodeAt(j) - 97);
      }
      prev = w;
    }
  }
  measure("AA. Global front-coded (share+26, 256-word blocks)", new Uint8Array(buf));
}

// ─── BB. Pure DAFSA / Minimal FSA ───
// Build a proper DAWG by minimizing the trie from the right
{
  // Build reversed-insertion trie and minimize
  // Actually, standard DAWG construction for sorted input:
  // Process words in sorted order, minimize suffixes as we go

  interface DAWGNode {
    children: Map<number, DAWGNode>;
    isEnd: boolean;
    registered: boolean;
  }

  let nodeCount = 0;
  function createNode(): DAWGNode {
    nodeCount++;
    return { children: new Map(), isEnd: false, registered: false };
  }

  // Registry for finding equivalent nodes
  const registry = new Map<string, DAWGNode>();

  function nodeSignature(node: DAWGNode): string {
    const parts: string[] = [node.isEnd ? "1" : "0"];
    const sortedKeys = [...node.children.keys()].sort((a, b) => a - b);
    for (const k of sortedKeys) {
      const childSig = nodeSignature(node.children.get(k)!);
      parts.push(`${k}:${childSig}`);
    }
    return parts.join(",");
  }

  function replaceOrRegister(node: DAWGNode): DAWGNode {
    // Process children first (bottom-up)
    for (const [ch, child] of node.children) {
      if (!child.registered) {
        const replacement = replaceOrRegister(child);
        if (replacement !== child) {
          node.children.set(ch, replacement);
          nodeCount--;
        }
      }
    }

    const sig = nodeSignature(node);
    const existing = registry.get(sig);
    if (existing) {
      return existing;
    }
    registry.set(sig, node);
    node.registered = true;
    return node;
  }

  const dawgRoot = createNode();
  let prevWord = "";

  // Build incrementally
  for (const w of words) {
    // Find common prefix length with previous word
    let commonLen = 0;
    while (commonLen < prevWord.length && commonLen < w.length && prevWord[commonLen] === w[commonLen]) {
      commonLen++;
    }

    // We need to minimize the suffixes of the previous word that diverge
    // For simplicity, build full trie first then minimize
    let node = dawgRoot;
    for (let i = 0; i < w.length; i++) {
      const ch = w.charCodeAt(i) - 97;
      let child = node.children.get(ch);
      if (!child) {
        child = createNode();
        node.children.set(ch, child);
      }
      node = child;
    }
    node.isEnd = true;
    prevWord = w;
  }

  // Now minimize the entire trie
  nodeCount = 0;
  function countDAWGNodes(node: DAWGNode, visited: Set<DAWGNode>) {
    if (visited.has(node)) return;
    visited.add(node);
    nodeCount++;
    for (const child of node.children.values()) {
      countDAWGNodes(child, visited);
    }
  }

  const beforeMin = new Set<DAWGNode>();
  countDAWGNodes(dawgRoot, beforeMin);
  const trieNodeCount = nodeCount;

  replaceOrRegister(dawgRoot);

  nodeCount = 0;
  const afterMin = new Set<DAWGNode>();
  countDAWGNodes(dawgRoot, afterMin);
  const dawgNodeCount = nodeCount;

  console.log(`\n─── DAWG stats ───`);
  console.log(`  Trie nodes before minimization: ${trieNodeCount}`);
  console.log(`  DAWG nodes after minimization: ${dawgNodeCount}`);
  console.log(`  Compression ratio: ${(dawgNodeCount / trieNodeCount * 100).toFixed(1)}%`);

  // Serialize DAWG: assign IDs, then store edges
  const nodeIds = new Map<DAWGNode, number>();
  let id = 0;
  const visited = new Set<DAWGNode>();
  function assignIds(node: DAWGNode) {
    if (visited.has(node)) return;
    visited.add(node);
    nodeIds.set(node, id++);
    const sortedKeys = [...node.children.keys()].sort((a, b) => a - b);
    for (const k of sortedKeys) {
      assignIds(node.children.get(k)!);
    }
  }
  assignIds(dawgRoot);

  // Serialize: for each node (in BFS order), store:
  // child_count:u8, then for each child: char:u8 | (isEnd<<5) | (target_node_id as u16le or varint)
  const dawgBuf: number[] = [];
  const totalDAWGNodes = nodeIds.size;
  dawgBuf.push(totalDAWGNodes & 0xff, (totalDAWGNodes >> 8) & 0xff, (totalDAWGNodes >> 16) & 0xff, (totalDAWGNodes >> 24) & 0xff);

  const orderedNodes: DAWGNode[] = new Array(totalDAWGNodes);
  for (const [node, nid] of nodeIds) {
    orderedNodes[nid] = node;
  }

  for (let i = 0; i < totalDAWGNodes; i++) {
    const node = orderedNodes[i];
    const sortedKeys = [...node.children.keys()].sort((a, b) => a - b);
    let flags = sortedKeys.length; // child count (0-26)
    if (node.isEnd) flags |= 0x80; // bit 7 = isEnd
    dawgBuf.push(flags);
    for (const k of sortedKeys) {
      const child = node.children.get(k)!;
      const childId = nodeIds.get(child)!;
      dawgBuf.push(k); // char 0-25
      // Child ID as u16le or u24le depending on total nodes
      if (totalDAWGNodes <= 65536) {
        dawgBuf.push(childId & 0xff, (childId >> 8) & 0xff);
      } else {
        dawgBuf.push(childId & 0xff, (childId >> 8) & 0xff, (childId >> 16) & 0xff);
      }
    }
  }
  measure("BB. DAWG (minimized trie, node+edge serialization)", new Uint8Array(dawgBuf));
}

// ─── CC. Global front-coded, but sort by reverse word (suffixes clustered) ───
{
  const reverseSorted = [...words].sort((a, b) => {
    // Sort by reversed string
    const ra = a.split("").reverse().join("");
    const rb = b.split("").reverse().join("");
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  const buf: number[] = [];
  const n = reverseSorted.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of reverseSorted) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared + 26);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("CC. Reverse-sorted front-coded (share+26 + suffix)", new Uint8Array(buf));
}

// ─── DD. Approach E but storing reversed words (suffix sharing instead of prefix sharing) ───
{
  const reversed = words.map(w => w.split("").reverse().join("")).sort();

  const buf: number[] = [];
  const n = reversed.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  let prev = "";
  for (const w of reversed) {
    const shared = sharedPrefix(prev, w);
    buf.push(shared + 26);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("DD. Reversed words sorted+front-coded (share+26 + suffix)", new Uint8Array(buf));
}

// ─── EE. Combined: approach E with front+back coding ───
// Store both forward and backward sorted, take whichever is smaller per block. Too complex. Skip.

// ─── FF. Approach B (baseline) but with prediction: suffix char[i] predicted as char[i] of prev word ───
// (Already covered by F and S, but let's try a more targeted version)

// ─── GG. Two-pass: first store all prefix_share values (highly compressible), then all suffixes ───
// (Already covered by Q but let's also try without suffix_len by using approach E's marker trick)
{
  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  // Pass 1: all share values as raw bytes
  const shareVals: number[] = [];
  let prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    shareVals.push(shared);
    prev = w;
  }
  for (const v of shareVals) buf.push(v);

  // Pass 2: all suffix chars concatenated (need suffix_len to parse, but we can derive from word boundaries)
  // Actually we need some way to know suffix lengths. Store suffix_len values too.
  prev = "";
  const suffLens: number[] = [];
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    suffLens.push(w.length - shared);
    prev = w;
  }
  for (const v of suffLens) buf.push(v);

  // Pass 3: suffix chars
  prev = "";
  for (const w of words) {
    const shared = sharedPrefix(prev, w);
    for (let i = shared; i < w.length; i++) {
      buf.push(w.charCodeAt(i) - 97);
    }
    prev = w;
  }
  measure("GG. Split streams v2 (share bytes | sufflen bytes | char bytes)", new Uint8Array(buf));
}

// ─── Print results table ─────────────────────────────────────────────

console.log("\n═══ PART 2: ENCODING COMPARISON ═══\n");
console.log(
  "│ " +
    "Approach".padEnd(65) +
    " │ " +
    "Raw KB".padStart(8) +
    " │ " +
    "GZ KB".padStart(8) +
    " │ " +
    "GZ vs txt".padStart(9) +
    " │"
);
console.log("│" + "─".repeat(67) + "│" + "─".repeat(10) + "│" + "─".repeat(10) + "│" + "─".repeat(11) + "│");

const txtGz = results[0].gzBytes;
const sortedResults = [...results].sort((a, b) => a.gzBytes - b.gzBytes);

for (const r of sortedResults) {
  const rawKB = (r.rawBytes / 1024).toFixed(0);
  const gzKB = (r.gzBytes / 1024).toFixed(0);
  const vsTxt = ((r.gzBytes / txtGz) * 100).toFixed(1) + "%";
  console.log(
    "│ " +
      r.name.padEnd(65).slice(0, 65) +
      " │ " +
      rawKB.padStart(8) +
      " │ " +
      gzKB.padStart(8) +
      " │ " +
      vsTxt.padStart(9) +
      " │"
  );
}

// Highlight winner
console.log("\n═══ RECOMMENDATION ═══\n");
const winner = sortedResults[0];
const runner = sortedResults[1];
console.log(`Best: ${winner.name}`);
console.log(`  Raw: ${(winner.rawBytes / 1024).toFixed(0)} KB, Gzipped: ${(winner.gzBytes / 1024).toFixed(0)} KB`);
console.log(`  vs raw text gzip: ${((winner.gzBytes / txtGz) * 100).toFixed(1)}%`);
console.log(`\nRunner-up: ${runner.name}`);
console.log(`  Raw: ${(runner.rawBytes / 1024).toFixed(0)} KB, Gzipped: ${(runner.gzBytes / 1024).toFixed(0)} KB`);
console.log(`  vs raw text gzip: ${((runner.gzBytes / txtGz) * 100).toFixed(1)}%`);
