import { describe, expect, it } from "vitest";
import { BigIntScalar } from "./scalars.js";

describe("BigInt scalar", () => {
  const maxUint256 = 2n ** 256n - 1n;

  it("serializes uint256-sized values without precision loss", () => {
    expect(BigIntScalar.serialize(maxUint256)).toBe(maxUint256.toString());
  });

  it("passes through pg numeric strings", () => {
    expect(BigIntScalar.serialize("123456789012345678901234567890")).toBe("123456789012345678901234567890");
  });

  it("parses string input into bigint", () => {
    expect(BigIntScalar.parseValue(maxUint256.toString())).toBe(maxUint256);
  });

  it("rejects non-integers", () => {
    expect(() => BigIntScalar.serialize(1.5)).toThrow();
    expect(() => BigIntScalar.parseValue("1e18")).toThrow();
  });
});
