import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("vault_events", (t) => {
    t.increments("id").primary();
    t.bigInteger("ledger").notNullable();
    t.string("tx_hash", 128).notNullable();
    t.integer("event_index").notNullable();
    t.string("type", 64).notNullable();
    t.string("address", 128).notNullable();
    t.specificType("usdc", "numeric").notNullable().defaultTo(0);
    t.specificType("shares", "numeric").notNullable().defaultTo(0);
    t.bigInteger("ts").notNullable();
    t.timestamps(true, true);

    // Idempotent upsert key: re-indexing the same transaction never duplicates rows.
    t.unique(["tx_hash", "event_index"]);
    // Serves the cursor-paginated activity feed (ORDER BY ts, tx_hash, event_index DESC).
    t.index(["address", "ts", "tx_hash", "event_index"]);
    t.index(["type"]);
  });

  await knex.schema.createTable("indexer_cursor", (t) => {
    t.string("name", 64).primary();
    t.bigInteger("last_ledger").notNullable().defaultTo(0);
    t.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("indexer_cursor");
  await knex.schema.dropTableIfExists("vault_events");
}
