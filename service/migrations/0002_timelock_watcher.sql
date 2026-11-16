-- Vault V2 timelock watcher schema. See docs/PLAN.md "Data model" and "Correctness rules".
-- Addresses and hashes are lowercase 0x-hex text: readable in psql and in API output.
-- (sync_cursor from 0001 keeps its bytea block_hash; migrations are forward-only.)

CREATE DOMAIN eth_address AS text CHECK (VALUE ~ '^0x[0-9a-f]{40}$');
CREATE DOMAIN eth_hash    AS text CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
CREATE DOMAIN eth_hex     AS text CHECK (VALUE ~ '^0x([0-9a-f]{2})*$');

-- Vaults we watch. Seeded from config (VAULTS=address:startBlock) plus onchain name/asset reads.
CREATE TABLE vault (
  address         eth_address PRIMARY KEY,
  chain_id        integer     NOT NULL,
  name            text,
  asset           eth_address,
  asset_symbol    text,
  asset_decimals  integer,
  start_block     bigint      NOT NULL CHECK (start_block >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Raw decoded logs. The unique key makes re-indexing a range a no-op.
CREATE TABLE vault_event (
  id               bigserial   PRIMARY KEY,
  chain_id         integer     NOT NULL,
  vault            eth_address NOT NULL REFERENCES vault(address),
  block_number     bigint      NOT NULL,
  block_hash       eth_hash    NOT NULL,
  block_timestamp  timestamptz NOT NULL,
  tx_hash          eth_hash    NOT NULL,
  log_index        integer     NOT NULL,
  event_name       text        NOT NULL CHECK (event_name IN ('Submit', 'Accept', 'Revoke')),
  selector         eth_hex     NOT NULL,
  data             eth_hex     NOT NULL,     -- the timelocked calldata
  executable_at    timestamptz,              -- Submit only
  sender           eth_address,              -- Revoke only
  UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX vault_event_block_idx ON vault_event (block_number);

-- One row per submitted change, following PENDING -> EXECUTED | REVOKED.
-- Keyed like the contract's executableAt[data]: at most one PENDING row per (vault, calldata).
CREATE TABLE timelock_change (
  id                       bigserial   PRIMARY KEY,
  vault                    eth_address NOT NULL REFERENCES vault(address),
  data                     eth_hex     NOT NULL,
  selector                 eth_hex     NOT NULL,
  function_name            text,                   -- null if the selector is unknown
  is_timelocked_function   boolean     NOT NULL,   -- false: can never be accepted (garbage in the queue)
  args                     jsonb,                  -- decoded arguments, bigints as strings
  decoded                  jsonb       NOT NULL,   -- cap id / label, unlimited flag, timelock target
  status                   text        NOT NULL CHECK (status IN ('PENDING', 'EXECUTED', 'REVOKED')),
  submit_event_id          bigint      NOT NULL REFERENCES vault_event(id) ON DELETE CASCADE,
  submitted_block          bigint      NOT NULL,
  submitted_tx             eth_hash    NOT NULL,
  submitted_at             timestamptz NOT NULL,
  executable_at            timestamptz NOT NULL,
  resolve_event_id         bigint      REFERENCES vault_event(id) ON DELETE SET NULL,
  resolved_block           bigint,
  resolved_tx              eth_hash,
  resolved_at              timestamptz,
  revoked_by               eth_address,
  CHECK ((status = 'PENDING') = (resolve_event_id IS NULL AND resolved_block IS NULL))
);
CREATE UNIQUE INDEX timelock_change_one_pending ON timelock_change (vault, data) WHERE status = 'PENDING';
CREATE INDEX timelock_change_status_idx ON timelock_change (status, executable_at);
CREATE INDEX timelock_change_vault_idx ON timelock_change (vault, submitted_block);

-- Webhook subscribers. The signing secret is encrypted (AES-256-GCM), not hashed: we need it to sign.
CREATE TABLE subscription (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  url                text        NOT NULL,
  vaults             eth_address[],          -- null = all watched vaults
  functions          text[],                 -- null = all functions
  start_block        bigint      NOT NULL,   -- only events after this block are delivered
  secret_ciphertext  bytea       NOT NULL,
  secret_iv          bytea       NOT NULL,
  secret_tag         bytea       NOT NULL,
  active             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Outbox. Rows are written by the indexer in the same transaction as the event they announce.
-- id doubles as the idempotency key sent to receivers (X-Delivery-Id).
CREATE TABLE delivery (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   uuid        NOT NULL REFERENCES subscription(id),
  change_id         bigint      NOT NULL REFERENCES timelock_change(id) ON DELETE CASCADE,
  event_type        text        NOT NULL CHECK (event_type IN ('change.submitted', 'change.executed', 'change.revoked')),
  block_number      bigint      NOT NULL,   -- block of the announced event (used to drop pending rows on reorg)
  payload           jsonb       NOT NULL,
  status            text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempts          integer     NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  locked_until      timestamptz,            -- lease while a worker is sending it
  last_error        text,
  last_status_code  integer,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, change_id, event_type)
);
CREATE INDEX delivery_due_idx ON delivery (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX delivery_subscription_idx ON delivery (subscription_id, created_at);
