import { describe, expect, it } from "vitest";
import { applyEvents, changeKey, type ChainEvent, type EventName } from "./lifecycle.js";

const VAULT = "0x00000000000000000000000000000000000000aa";
let nextId = 1;
const ev = (eventName: EventName, data: string, blockNumber: number, logIndex = 0): ChainEvent => ({
  eventId: nextId++,
  vault: VAULT,
  eventName,
  data,
  blockNumber,
  logIndex,
});

describe("applyEvents", () => {
  it("submit then accept in a later batch resolves the stored change as EXECUTED", () => {
    const pending = new Map([[changeKey(VAULT, "0xaa"), 42]]);
    const ops = applyEvents(pending, [ev("Accept", "0xaa", 10)]);
    expect(ops).toEqual([expect.objectContaining({ op: "resolve", changeId: 42, status: "EXECUTED" })]);
  });

  it("revoke resolves as REVOKED", () => {
    const ops = applyEvents(new Map([[changeKey(VAULT, "0xaa"), 7]]), [ev("Revoke", "0xaa", 10)]);
    expect(ops[0]).toMatchObject({ op: "resolve", changeId: 7, status: "REVOKED" });
  });

  it("zero timelock: Submit and Accept in the same tx resolve within the batch", () => {
    const submit = ev("Submit", "0xbb", 5, 1);
    const ops = applyEvents(new Map(), [ev("Accept", "0xbb", 5, 2), submit]); // given out of order on purpose
    expect(ops.map((o) => o.op)).toEqual(["create", "resolve"]);
    expect(ops[1]).toMatchObject({ changeId: "created-in-batch", createdBy: submit, status: "EXECUTED" });
  });

  it("the same calldata can be submitted again after it was accepted or revoked", () => {
    const ops = applyEvents(new Map(), [
      ev("Submit", "0xcc", 1),
      ev("Revoke", "0xcc", 2),
      ev("Submit", "0xcc", 3),
      ev("Accept", "0xcc", 4),
    ]);
    expect(ops.map((o) => o.op)).toEqual(["create", "resolve", "create", "resolve"]);
    expect(ops.filter((o) => o.op === "resolve").map((o) => (o as { status: string }).status)).toEqual(["REVOKED", "EXECUTED"]);
  });

  it("reports an Accept with no pending Submit as an anomaly instead of throwing", () => {
    const ops = applyEvents(new Map(), [ev("Accept", "0xdd", 1)]);
    expect(ops).toEqual([expect.objectContaining({ op: "anomaly", kind: "orphan-resolve" })]);
  });

  it("reports a Submit while the same calldata is still pending as an anomaly", () => {
    const ops = applyEvents(new Map([[changeKey(VAULT, "0xee"), 3]]), [ev("Submit", "0xee", 1)]);
    expect(ops).toEqual([expect.objectContaining({ op: "anomaly", kind: "duplicate-submit" })]);
  });

  it("keys are case-insensitive", () => {
    const ops = applyEvents(new Map([[changeKey(VAULT.toUpperCase(), "0xAbCd"), 9]]), [ev("Accept", "0xabcd", 1)]);
    expect(ops[0]).toMatchObject({ op: "resolve", changeId: 9 });
  });
});
