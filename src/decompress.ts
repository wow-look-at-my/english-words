export function decompress(data: Uint8Array): string[] {
  if (data[0] !== 69 || data[1] !== 87 || data[2] !== 68 || data[3] !== 2) {
    throw new Error("Invalid EWD v2 format");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const maxLen = data[4];

  const counts: number[] = new Array(maxLen);
  let totalWords = 0;
  for (let i = 0; i < maxLen; i++) {
    counts[i] = view.getUint32(5 + i * 4, true);
    totalWords += counts[i];
  }

  const words: string[] = new Array(totalWords);
  let wi = 0;
  let pos = 5 + maxLen * 4;

  for (let li = 0; li < maxLen; li++) {
    const wordLen = li + 1;
    const count = counts[li];
    if (count === 0) continue;

    const buf: number[] = new Array(wordLen).fill(0);

    for (let w = 0; w < count; w++) {
      const shared = data[pos++];
      for (let c = shared; c < wordLen; c++) {
        buf[c] = data[pos++];
      }
      let word = "";
      for (let c = 0; c < wordLen; c++) {
        word += String.fromCharCode(97 + buf[c]);
      }
      words[wi++] = word;
    }
  }

  return words;
}
