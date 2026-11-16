# Example webhooks (real events)

These are the exact bodies the service queued while replaying recorded Base history (`docker compose run --rm replay`).
Each one would have reached a subscriber when the event happened onchain. Check any of them on BaseScan with `event.txHash`.

| File | What happened | What the subscriber learned, and when |
|---|---|---|
| `1-cbbtc-cap-submitted.json` | Steakhouse High Yield USDC Edition submitted a cbBTC collateral cap of 500M USDC | 2026-11-09 07:44: **3 days' warning** before it could take effect (executable 2026-11-12 07:44) |
| `2-cbbtc-cap-executed.json` | The same change was executed | 2026-11-12 15:02: 7h after it became executable |
| `3-syrupusdc-market-revoked.json` | A 100M USDC cap on the syrupUSDC/USDC 91.5% LLTV market was revoked | 2026-09-30, after 5 weeks pending (submitted 2026-08-23) |
| `4-paxg-cap-submitted-still-pending.json` | Gauntlet USDC Frontier submitted a 2M USDC PAXG collateral cap | Executable since 2026-11-13 and not yet executed at the end of the recording |
| `5-zero-timelock-executed-same-tx.json` | Splits Earn USDC raised an adapter cap to unlimited with a zero timelock | Submitted and executed in the same transaction: the alert can only arrive after the fact, which is itself the signal |

Curators usually submit several changes in one transaction (absolute + relative cap, for both the collateral id and the market id). Group alerts by `event.txHash` to show them as one curator action.

## Headers
```
POST /your/webhook
content-type: application/json
x-delivery-id: 7550f869-6c51-4f8c-b4ec-16aad8b7ee8b      ← same on every retry: dedupe on it
x-signature: t=1794850000,v1=5f0c…(hex HMAC-SHA256)
```

## Verifying a webhook (receiver side)
The secret is returned once by `createSubscription`. Compute `HMAC-SHA256(secret, "<t>.<raw body>")`, compare in constant time, and reject old `t` (replay protection). This is the same function the demo receivers use (`service/src/delivery/signing.ts`):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret: string, header: string | undefined, rawBody: string, nowSeconds: number) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  if (Math.abs(nowSeconds - Number(m[1])) > 300) return false; // too old (or from the future): reject
  const expected = createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest();
  const given = Buffer.from(m[2]!, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```
Respond 2xx quickly. Anything else (or no answer within 5s) is retried: 30s, 2m, 10m, 1h, 3h, 6h, 12h, then the delivery is marked `FAILED` and shows as failed in the API.
