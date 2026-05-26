import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const text = readFileSync("words_alpha.txt", "utf-8");
const words = [
  ...new Set(text.split(/\r?\n/).map((w) => w.toLowerCase().trim()).filter(Boolean)),
].sort();

console.log(`Loaded ${words.length} words`);

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

// ─── Test all combinations of rotation + sort order + char bit position ───
console.log("Testing rotation x sort_order x char_bits combos...\n");

let bestGz = Infinity;
let bestConfig = "";

for (const sortOrder of ["asc", "desc"] as const) {
  for (const charPos of ["lower5", "upper5"] as const) {
    for (let rot = 0; rot < 26; rot++) {
      const buf: number[] = [];
      const n = words.length;
      buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

      function serialize(node: TrieNode) {
        const keys = [...node.children.keys()];
        if (sortOrder === "asc") {
          keys.sort((a, b) => ((a + rot) % 26) - ((b + rot) % 26));
        } else {
          keys.sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
        }
        for (let i = 0; i < keys.length; i++) {
          const ch = keys[i];
          const child = node.children.get(ch)!;
          let byte: number;
          if (charPos === "lower5") {
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

      const gz = gzipSync(Buffer.from(new Uint8Array(buf)), { level: 9 });
      const config = `sort=${sortOrder}, char=${charPos}, rot=${rot}`;
      if (gz.length < bestGz) {
        bestGz = gz.length;
        bestConfig = config;
        console.log(`  NEW BEST: ${config} => ${(gz.length / 1024).toFixed(1)} KB (${gz.length} bytes)`);
      }
    }
  }
}

console.log(`\nOverall best: ${bestConfig} => ${(bestGz / 1024).toFixed(1)} KB`);

// ─── Now try the top combos with brotli ───
{
  const { brotliCompressSync, constants } = await import("node:zlib");
  console.log("\n─── Top configs with brotli ───");

  // Regenerate the best config
  for (const sortOrder of ["desc"] as const) {
    for (const charPos of ["upper5"] as const) {
      for (const rot of [0, 6, 17]) {
        const buf: number[] = [];
        const n = words.length;
        buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

        function serialize(node: TrieNode) {
          const keys = [...node.children.keys()];
          keys.sort((a, b) => ((b + rot) % 26) - ((a + rot) % 26));
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

        const data = new Uint8Array(buf);
        const gz = gzipSync(Buffer.from(data), { level: 9 });
        const br = brotliCompressSync(Buffer.from(data), {
          params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
        });
        console.log(`  sort=desc, char=upper5, rot=${rot}: gzip=${(gz.length / 1024).toFixed(0)} KB, brotli=${(br.length / 1024).toFixed(0)} KB`);
      }
    }
  }
}

// ─── Final: verify the best gzip config roundtrips correctly ───
{
  console.log("\n─── Roundtrip verification of best config ───");
  // Best was sort=desc, char=upper5, rot=17 (or similar)
  // Actually let's find it properly
  const bestParts = bestConfig.match(/sort=(\w+), char=(\w+), rot=(\d+)/);
  if (!bestParts) { console.error("Can't parse best config"); process.exit(1); }
  const bSortOrder = bestParts[1] as "asc" | "desc";
  const bCharPos = bestParts[2] as "lower5" | "upper5";
  const bRot = parseInt(bestParts[3]);

  const buf: number[] = [];
  const n = words.length;
  buf.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);

  function serialize(node: TrieNode) {
    const keys = [...node.children.keys()];
    if (bSortOrder === "asc") {
      keys.sort((a, b) => ((a + bRot) % 26) - ((b + bRot) % 26));
    } else {
      keys.sort((a, b) => ((b + bRot) % 26) - ((a + bRot) % 26));
    }
    for (let i = 0; i < keys.length; i++) {
      const ch = keys[i];
      const child = node.children.get(ch)!;
      let byte: number;
      if (bCharPos === "lower5") {
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

  const data = new Uint8Array(buf);
  const gz = gzipSync(Buffer.from(data), { level: 9 });

  // Decode
  const decoded: string[] = [];
  let pos = 4;
  const stack: number[] = [];

  function decode() {
    while (pos < data.length) {
      const b = data[pos++];
      let ch: number, isEnd: boolean, hasChildren: boolean, isLast: boolean;
      if (bCharPos === "lower5") {
        ch = b & 0x1f;
        isEnd = !!(b & 0x20);
        hasChildren = !!(b & 0x40);
        isLast = !!(b & 0x80);
      } else {
        ch = (b >> 3) & 0x1f;
        isEnd = !!(b & 0x01);
        hasChildren = !!(b & 0x02);
        isLast = !!(b & 0x04);
      }
      stack.push(ch + 97);
      if (isEnd) decoded.push(String.fromCharCode(...stack));
      if (hasChildren) decode();
      stack.pop();
      if (isLast) return;
    }
  }
  decode();
  decoded.sort();

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
    if (ok) {
      console.log(`Roundtrip OK! ${decoded.length} words verified.`);
      console.log(`Raw: ${data.length} bytes (${(data.length / 1024).toFixed(0)} KB)`);
      console.log(`Gzip: ${gz.length} bytes (${(gz.length / 1024).toFixed(0)} KB)`);
    }
  }
}
