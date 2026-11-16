-- Progress fields on the cursor, so the API can report chain time and indexer lag without calling the RPC.
-- block_timestamp: timestamp of last_block. This is the service's notion of "now" (chain time, not wall clock).
-- head_block: the chain head the indexer saw on its last poll (lag = head_block - last_block).
ALTER TABLE sync_cursor
  ADD COLUMN block_timestamp timestamptz,
  ADD COLUMN head_block      bigint;
