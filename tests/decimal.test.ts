import { describe, expect, it } from "vitest";

import * as decimal from "../src/decimal.js";
import { PerpUsageError } from "../src/errors.js";

describe("parse and format", () => {
  it("round-trips values that a float would corrupt", () => {
    for (const value of ["0.1", "0.2", "18446744073709551615", "0.000001", "-0.0000001"]) {
      expect(decimal.format(decimal.parse(value))).toBe(value);
    }
  });

  it("normalises negative zero to 0", () => {
    expect(decimal.format(decimal.parse("-0.000"))).toBe("0");
  });

  it("strips trailing fractional zeros", () => {
    expect(decimal.format(decimal.parse("1.2500"))).toBe("1.25");
    expect(decimal.format(decimal.parse("3.000"))).toBe("3");
  });

  it("rejects anything that is not plain decimal text", () => {
    for (const value of ["1e5", "+1", "1,5", "", " ", "abc", "1.2.3"]) {
      expect(() => decimal.parse(value)).toThrow(PerpUsageError);
    }
  });
});

describe("arithmetic", () => {
  it("adds without binary floating point error", () => {
    expect(decimal.add("0.1", "0.2")).toBe("0.3");
  });

  it("multiplies exactly across scales", () => {
    expect(decimal.multiply("0.01", "184.205")).toBe("1.84205");
  });

  it("subtracts across signs", () => {
    expect(decimal.subtract("1", "1.5")).toBe("-0.5");
  });

  it("compares by value, not by string", () => {
    expect(decimal.compare("1.10", "1.1")).toBe(0);
    expect(decimal.compare("2", "10")).toBe(-1);
    expect(decimal.compare("-1", "-2")).toBe(1);
  });
});

describe("roundToMultiple", () => {
  it("rounds toward zero by default so an order never grows", () => {
    expect(decimal.roundToMultiple("0.0179", "0.001")).toBe("0.017");
    expect(decimal.roundToMultiple("-0.0179", "0.001")).toBe("-0.017");
  });

  it("rounds away from zero on up", () => {
    expect(decimal.roundToMultiple("0.0171", "0.001", "up")).toBe("0.018");
    expect(decimal.roundToMultiple("-0.0171", "0.001", "up")).toBe("-0.018");
  });

  it("rounds halves away from zero on nearest", () => {
    expect(decimal.roundToMultiple("184.2050", "0.01", "nearest")).toBe("184.21");
    expect(decimal.roundToMultiple("184.2049", "0.01", "nearest")).toBe("184.2");
  });

  it("leaves an already aligned value untouched", () => {
    expect(decimal.roundToMultiple("0.5", "0.1")).toBe("0.5");
  });

  it("refuses a zero step", () => {
    expect(() => decimal.roundToMultiple("1", "0")).toThrow(PerpUsageError);
  });
});

describe("clamp", () => {
  it("applies each bound independently", () => {
    expect(decimal.clamp("5", { minimum: "10" })).toBe("10");
    expect(decimal.clamp("50", { maximum: "10" })).toBe("10");
    expect(decimal.clamp("5", {})).toBe("5");
  });
});
