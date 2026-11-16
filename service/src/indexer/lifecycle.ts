/**
 * Lifecycle of a timelocked change, as a pure function over ordered events.
 *
 * Mirrors VaultV2.sol: the contract keeps executableAt[data]; submit() requires it to be 0 (DataAlreadyPending),
 * accept (the timelocked call) and revoke() both require it to be non-zero and reset it to 0.
 * So a change is identified by (vault, calldata) while pending, and the same calldata may be submitted again later.
 */

export type EventName = "Submit" | "Accept" | "Revoke";

export interface ChainEvent {
  /** Database id of the stored vault_event row. */
  eventId: number;
  vault: string;
  eventName: EventName;
  data: string;
  blockNumber: number;
  logIndex: number;
}

/** Key the contract uses: one pending entry per (vault, calldata). */
export const changeKey = (vault: string, data: string) => `${vault.toLowerCase()}|${data.toLowerCase()}`;

export type LifecycleOp =
  | { op: "create"; event: ChainEvent }
  | { op: "resolve"; changeId: number | "created-in-batch"; createdBy?: ChainEvent; status: "EXECUTED" | "REVOKED"; event: ChainEvent }
  | { op: "anomaly"; kind: "orphan-resolve" | "duplicate-submit"; event: ChainEvent };

/**
 * Apply events in order. `pending` maps changeKey → id of the PENDING change already in the database.
 * Returns the operations to perform; never throws, because one odd event must not stop indexing.
 *
 * Changes created within the same batch are tracked by their creating event, so "Submit then Accept in the same
 * transaction" (zero timelock) resolves correctly before anything is written.
 */
export function applyEvents(pending: ReadonlyMap<string, number>, events: readonly ChainEvent[]): LifecycleOp[] {
  const ordered = [...events].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const open = new Map<string, number | ChainEvent>(pending);
  const ops: LifecycleOp[] = [];

  for (const ev of ordered) {
    const key = changeKey(ev.vault, ev.data);
    const current = open.get(key);
    if (ev.eventName === "Submit") {
      if (current !== undefined) {
        // The contract reverts on this, so seeing it means our state is wrong (e.g. a missed Accept).
        ops.push({ op: "anomaly", kind: "duplicate-submit", event: ev });
        continue;
      }
      open.set(key, ev);
      ops.push({ op: "create", event: ev });
    } else {
      if (current === undefined) {
        ops.push({ op: "anomaly", kind: "orphan-resolve", event: ev });
        continue;
      }
      open.delete(key);
      ops.push(
        typeof current === "number"
          ? { op: "resolve", changeId: current, status: ev.eventName === "Accept" ? "EXECUTED" : "REVOKED", event: ev }
          : { op: "resolve", changeId: "created-in-batch", createdBy: current, status: ev.eventName === "Accept" ? "EXECUTED" : "REVOKED", event: ev },
      );
    }
  }
  return ops;
}
