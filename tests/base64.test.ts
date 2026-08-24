import { describe, expect, it } from "vitest";

import { decodeBase64, encodeBase64 } from "../src/base64.js";

describe("base64", () => {
  it("round-trips bytes above 0x7f that atob/btoa would mangle", () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index++) bytes[index] = index;
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  it("matches a known encoding", () => {
    expect(encodeBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    expect(new TextDecoder().decode(decodeBase64("aGVsbG8="))).toBe("hello");
  });

  it("handles every padding length", () => {
    for (const text of ["", "a", "ab", "abc", "abcd"]) {
      const bytes = new TextEncoder().encode(text);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });

  it("rejects invalid characters", () => {
    expect(() => decodeBase64("aGVs*G8=")).toThrow(/invalid base64/);
  });
});
