export function decompress(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(0, true);
    const result = new Array(count);
    let wi = 0;
    let pos = 4;
    const stack = [];
    function walk() {
        while (pos < data.length) {
            const b = data[pos++];
            stack.push((b & 0x1f) + 97);
            if (b & 0x20)
                result[wi++] = String.fromCharCode(...stack);
            if (b & 0x40)
                walk();
            stack.pop();
            if (b & 0x80)
                return;
        }
    }
    walk();
    return result;
}
