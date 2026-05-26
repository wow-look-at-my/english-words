List Of English Words
=============

370,105 English words, available as plain text and a compact binary format.

Served via GitHub Pages as a lightweight dictionary CDN.

## CDN Usage

The binary format (`words_alpha.dict.bin`) is ~2 MB raw, ~884 KB gzipped.
A TypeScript decompressor is provided:

```typescript
import { decompress } from 'https://wow-look-at-my.github.io/english-words/decompress.js';

const resp = await fetch('https://wow-look-at-my.github.io/english-words/words_alpha.dict.bin');
const buf = new Uint8Array(await resp.arrayBuffer());
const words = decompress(buf); // string[], 370105 words
```

## Files

| File | Format | Size |
|------|--------|------|
| `words_alpha.dict.bin` | Binary (length-grouped, front-coded) | ~2 MB |
| `words_alpha.dict.bin.gz` | Gzipped binary | ~884 KB |
| `words_alpha.txt` | Plain text (one word per line) | 4.1 MB |

## Binary Format (EWD v2)

Words are grouped by length and front-coded within each group:

```
Header: 'EWD' 0x02 max_len:u8 counts[max_len]:u32le
Body per group (length L, count C):
  C words, each: shared:u8 suffix[L-shared]:u8 (char = 0..25)
  sorted alphabetically, front-coded against previous word
```

No separators or terminators needed -- all words in a group share the same length.

## Building

```bash
npm install
npm run build    # compresses dictionary and builds site/
```

## Source

Originally from [infochimps](https://web.archive.org/web/20131118073324/https://www.infochimps.com/datasets/word-list-350000-simple-english-words-excel-readable) via [StackOverflow](https://stackoverflow.com/questions/2213607/how-to-get-english-language-word-database).
