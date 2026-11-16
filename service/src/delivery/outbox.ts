import type pg from "pg";

export type AlertType = "change.submitted" | "change.executed" | "change.revoked";

/** Body of a webhook (the worker adds `deliveryId` when sending). Same for every subscriber of an event. */
export interface AlertPayload {
  type: AlertType;
  chainId: number;
  vault: { address: string; name: string | null };
  change: {
    id: number;
    status: "PENDING" | "EXECUTED" | "REVOKED";
    functionName: string | null;
    summary: string;
    args: unknown;
    decoded: unknown;
    isTimelockedFunction: boolean;
    submittedAt: string;
    executableAt: string;
    submitTx: string;
    resolvedAt: string | null;
    resolvedTx: string | null;
    revokedBy: string | null;
  };
  /** The onchain event this alert announces. Receivers can group alerts by txHash: curators bundle changes. */
  event: { name: "Submit" | "Accept" | "Revoke"; txHash: string; blockNumber: number; blockTimestamp: string };
}

/**
 * Queue one delivery per matching, active subscription. Runs inside the indexer's transaction, so the
 * event and its deliveries are committed together or not at all (the outbox pattern).
 *
 * A subscription matches when:
 *   - it was created before this block (start_block < event block): no alerts for history it subscribed after,
 *   - its vault filter is empty or contains the vault,
 *   - its function filter is empty or contains the function name.
 * The unique (subscription, change, event_type) key makes a re-run insert nothing.
 */
export async function queueDeliveries(client: pg.PoolClient, payload: AlertPayload): Promise<number> {
  const res = await client.query(
    `INSERT INTO delivery (subscription_id, change_id, event_type, block_number, payload)
     SELECT s.id, $1, $2, $3, $4::jsonb
       FROM subscription s
      WHERE s.active
        AND s.start_block < $3
        AND (s.vaults IS NULL OR $5::text = ANY (s.vaults::text[]))
        AND (s.functions IS NULL OR $6::text = ANY (s.functions))
     ON CONFLICT (subscription_id, change_id, event_type) DO NOTHING`,
    [
      payload.change.id,
      payload.type,
      payload.event.blockNumber,
      JSON.stringify(payload),
      payload.vault.address,
      payload.change.functionName ?? "",
    ],
  );
  return res.rowCount ?? 0;
}
