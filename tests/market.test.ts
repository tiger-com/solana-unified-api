import { describe, expect, it } from "vitest";

import { PerpUsageError } from "../src/errors.js";
import { alignPrice, alignQuantity, validateOrder } from "../src/market.js";
import { SOL_PERP } from "./helpers.js";

describe("alignment", () => {
  it("snaps a quantity down to the step", () => {
    expect(alignQuantity(SOL_PERP, "0.0179")).toBe("0.017");
  });

  it("snaps a price to the nearest tick", () => {
    expect(alignPrice(SOL_PERP, "184.2049")).toBe("184.2");
    expect(alignPrice(SOL_PERP, "184.2051")).toBe("184.21");
  });
});

describe("validateOrder", () => {
  const valid = { quantity: "0.1", price: "184.2" };

  it("accepts an aligned order that clears every limit", () => {
    expect(() => validateOrder(SOL_PERP, valid)).not.toThrow();
  });

  it("rejects a quantity off the step grid", () => {
    expect(() => validateOrder(SOL_PERP, { ...valid, quantity: "0.1005" })).toThrow(
      /quantity_step/,
    );
  });

  it("rejects a quantity below the minimum", () => {
    expect(() => validateOrder(SOL_PERP, { ...valid, quantity: "0.001" })).toThrow(
      /minimum_quantity/,
    );
  });

  it("rejects a price off the tick grid", () => {
    expect(() => validateOrder(SOL_PERP, { ...valid, price: "184.205" })).toThrow(/price_tick/);
  });

  it("rejects notional below the published minimum", () => {
    // 0.05 * 184.20 = 9.21, under the 10 minimum.
    expect(() => validateOrder(SOL_PERP, { quantity: "0.05", price: "184.2" })).toThrow(
      /minimum_notional/,
    );
  });

  it("does not invent a notional limit when the venue publishes none", () => {
    const { minimum_notional: _omitted, ...noNotional } = SOL_PERP;
    expect(() => validateOrder(noNotional, { quantity: "0.05", price: "184.2" })).not.toThrow();
  });

  it("enforces max_market_quantity only for MARKET orders", () => {
    const capped = { ...SOL_PERP, max_market_quantity: "1" };
    expect(() => validateOrder(capped, { quantity: "5", kind: "MARKET" })).toThrow(
      /max_market_quantity/,
    );
    expect(() => validateOrder(capped, { quantity: "5", kind: "LIMIT", price: "184.2" })).not.toThrow();
  });

  it("rejects a market that is closed for trading", () => {
    expect(() => validateOrder({ ...SOL_PERP, trading_supported: false }, valid)).toThrow(
      PerpUsageError,
    );
  });
});
