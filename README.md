List Of English Words
=============

370,105 English words, available as plain text and a compact binary format.

Served via GitHub Pages as a lightweight dictionary CDN.

## CDN Usage

The binary format (`words_alpha.dict.bin`) is 1004 KB raw, 589 KB gzipped.
A TypeScript decompressor is provided:

```typescript
import { decompress } from 'https://wow-look-at-my.github.io/english-words/decompress.js';

const resp = await fetch('https://wow-look-at-my.github.io/english-words/words_alpha.dict.bin');
const buf = new Uint8Array(await resp.arrayBuffer());
const words = decompress(buf); // string[], 370105 words sorted alphabetically
```

## Files

| File | Format | Size |
|------|--------|------|
| `words_alpha.dict.bin` | Binary (DFS-serialized trie) | 1004 KB |
| `words_alpha.dict.bin.gz` | Gzipped binary | 589 KB |
| `words_alpha.txt` | Plain text (one word per line) | 4136 KB |

## Binary Format

The dictionary is stored as a DFS-serialized trie. Shared prefixes are represented
once. Each trie edge is encoded as a single byte:

```
Header: 4 bytes (word count as uint32 LE)

Body: 1 byte per trie edge (DFS order)
  bits 0-4: character (0-25 for a-z)
  bit 5:    end-of-word (this edge completes a valid word)
  bit 6:    has children (the target node has outgoing edges)
  bit 7:    last sibling (last child of the parent node)
```

45% smaller than gzipping the plain text.

## Building

```bash
npm install
npm run build    # compresses dictionary and builds site/
```

## Source

Originally from [infochimps](https://web.archive.org/web/20131118073324/https://www.infochimps.com/datasets/word-list-350000-simple-english-words-excel-readable) via [StackOverflow](https://stackoverflow.com/questions/2213607/how-to-get-english-language-word-database).
