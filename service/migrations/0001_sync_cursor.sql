-- Tracks how far each indexer stream has processed the chain.
-- Every direction we're considering is event-driven, so this is shared infrastructure.
-- block_hash lets us detect a reorg: if the canonical block at last_block has a different hash, we rewind.
CREATE TABLE sync_cursor (
  stream      text        PRIMARY KEY,
  chain_id    integer     NOT NULL,
  last_block  bigint      NOT NULL CHECK (last_block >= 0),
  block_hash  bytea       NOT NULL CHECK (octet_length(block_hash) = 32),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
