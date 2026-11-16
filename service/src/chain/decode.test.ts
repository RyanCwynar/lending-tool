import { beforeAll, describe, expect, it } from "vitest";
import { decodeEventLog, decodeFunctionResult, type Hex } from "viem";
import { erc20ReadAbi, timelockEventsAbi } from "./abi.js";
import { decodeCapId, decodeTimelockCall, isUnlimitedCap } from "./decode.js";
import { describeChange, wadToPercent, type TokenInfo } from "./describe.js";
import { loadFixture, type Fixture } from "../harness/fixture.js";

// Real calldata from the fixture (recorded from Base mainnet), looked up by Submit tx hash.
let fixture: Fixture;
const tokens = new Map<string, TokenInfo>();
const usdc: TokenInfo = { symbol: "USDC", decimals: 6 };

function submitsInTx(tx: string): Hex[] {
  return fixture.logs
    .filter((l) => l.transactionHash === tx)
    .map((l) => decodeEventLog({ abi: timelockEventsAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }))
    .filter((e) => e.eventName === "Submit")
    .map((e) => (e.args as { data: Hex }).data);
}

beforeAll(async () => {
  fixture = await loadFixture("fixtures/base-timelocks.json");
  // Rebuild token metadata from the recorded eth_call results (symbol() = 0x95d89b41, decimals() = 0x313ce567).
  for (const c of fixture.calls) {
    const t = tokens.get(c.to) ?? { symbol: null, decimals: null };
    if (c.data === "0x95d89b41") t.symbol = decodeFunctionResult({ abi: erc20ReadAbi, functionName: "symbol", data: c.result as Hex });
    if (c.data === "0x313ce567") t.decimals = decodeFunctionResult({ abi: erc20ReadAbi, functionName: "decimals", data: c.result as Hex });
    tokens.set(c.to, t);
  }
});

describe("decodeTimelockCall on real calldata", () => {
  it("decodes every Submit in the fixture without throwing", () => {
    const submits = fixture.logs
      .map((l) => decodeEventLog({ abi: timelockEventsAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }))
      .filter((e) => e.eventName === "Submit");
    expect(submits).toHaveLength(333);
    for (const s of submits) expect(() => decodeTimelockCall((s.args as { data: Hex }).data)).not.toThrow();
  });

  it("cbBTC collateral cap raised to 500M USDC (Steakhouse High Yield Edition, research example 1)", () => {
    const calls = submitsInTx("0x110954fd52ce28366eb2a536f006420d671a2ec6879c5c0cdc1649daae38f7b9").map(decodeTimelockCall);
    const collateral = calls.find((c) => c.capId?.kind === "collateral" && c.functionName === "increaseAbsoluteCap")!;
    expect(collateral.isTimelockedFunction).toBe(true);
    expect(collateral.unlimited).toBe(false);
    expect(describeChange(collateral, (a) => tokens.get(a), usdc)).toBe(
      "Increase absolute cap on collateral cbBTC to 500,000,000 USDC",
    );
    const market = calls.find((c) => c.capId?.kind === "market")!;
    expect(describeChange(market, (a) => tokens.get(a), usdc)).toBe(
      "Increase absolute cap on market cbBTC/USDC @ 86% LLTV to 500,000,000 USDC",
    );
  });

  it("flags an unlimited adapter cap (Gauntlet USDC Prime, research example 3)", () => {
    const [call] = submitsInTx("0xa5492a58a65b171f9aa69aa12e1485ce47af073cb747676d94ef3efefdee7fb1").map(decodeTimelockCall);
    expect(call!.capId?.kind).toBe("adapter");
    expect(call!.unlimited).toBe(true);
    expect(describeChange(call!, (a) => tokens.get(a), usdc)).toMatch(/^Increase absolute cap on adapter 0x.*to unlimited$/);
  });

  it("decodes the syrupUSDC market at 91.5% LLTV (research example 2)", () => {
    const calls = submitsInTx("0xbae5d112157b0113dc87475a6c8fd888e03df9855e46fbf7dfe10cd873ce5409").map(decodeTimelockCall);
    const market = calls.find((c) => c.capId?.kind === "market" && c.functionName === "increaseRelativeCap")!;
    expect(describeChange(market, (a) => tokens.get(a), usdc)).toBe(
      "Increase relative cap on market syrupUSDC/USDC @ 91.5% LLTV to 100%",
    );
  });

  it("keeps non-timelocked submissions (garbage in the queue) instead of failing", () => {
    const decoded = fixture.logs
      .map((l) => decodeEventLog({ abi: timelockEventsAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }))
      .filter((e) => e.eventName === "Submit")
      .map((e) => decodeTimelockCall((e.args as { data: Hex }).data))
      .filter((d) => !d.isTimelockedFunction);
    expect(decoded.length).toBeGreaterThan(0);
    for (const d of decoded) expect(describeChange(d, () => undefined, usdc)).toMatch(/can never be executed/);
  });

  it("names the target function of real increaseTimelock submissions", () => {
    const timelockChanges = fixture.logs
      .map((l) => decodeEventLog({ abi: timelockEventsAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] }))
      .filter((e) => e.eventName === "Submit")
      .map((e) => decodeTimelockCall((e.args as { data: Hex }).data))
      .filter((d) => d.functionName === "increaseTimelock");
    expect(timelockChanges.length).toBeGreaterThan(0);
    const named = timelockChanges.filter((d) => !d.targetFunction?.startsWith("0x"));
    expect(named.length).toBeGreaterThan(0);
    expect(describeChange(named[0]!, () => undefined, usdc)).toMatch(/^Increase timelock of [a-zA-Z]+ to \d+[dhs]$/);
  });

  it("never throws on truncated calldata", () => {
    expect(decodeTimelockCall("0x47966291" as Hex).args).toBeNull();
  });
});

describe("helpers", () => {
  it("recognises both unlimited encodings", () => {
    expect(isUnlimitedCap((1n << 128n) - 1n)).toBe(true);
    expect(isUnlimitedCap((1n << 256n) - 1n)).toBe(true);
    expect(isUnlimitedCap(10n ** 24n)).toBe(false);
  });
  it("formats WAD percentages", () => {
    expect(wadToPercent(915_000_000_000_000_000n)).toBe("91.5%");
    expect(wadToPercent(10n ** 18n)).toBe("100%");
    expect(wadToPercent(0n)).toBe("0%");
  });
  it("returns unknown for unrecognised idData", () => {
    expect(decodeCapId("0x1234")).toEqual({ kind: "unknown", tag: null });
  });
});
