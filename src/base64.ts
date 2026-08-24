const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const LOOKUP = /* @__PURE__ */ (() => {
  const table = new Uint8Array(128).fill(255);
  for (let index = 0; index < ALPHABET.length; index++) {
    table[ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/**
 * Base64 codecs that work identically in Node and the browser.
 *
 * `atob`/`btoa` mangle bytes above 0x7f through their latin-1 string round
 * trip, and `Buffer` does not exist in a browser bundle; transaction wires
 * cannot tolerate either.
 */
export function decodeBase64(encoded: string): Uint8Array {
  const clean = encoded.replace(/[\s=]+$/g, "");
  const bytes = new Uint8Array((clean.length * 3) >> 2);

  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < clean.length; index++) {
    const value = LOOKUP[clean.charCodeAt(index)] ?? 255;
    if (value === 255) throw new Error(`invalid base64 character at index ${index}`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, offset);
}

export function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += ALPHABET[a >> 2];
    output += ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined ? "=" : ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? "=" : ALPHABET[c & 0x3f];
  }
  return output;
}
