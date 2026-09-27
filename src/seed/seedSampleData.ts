import { type DatabaseAdapter } from '@mcp-llm/database';
import { SAMPLE_TABLES, type SampleTable } from './sampleData';

export interface SampleSeedResult {
  table: string;
  /** Rows inserted by this run; rows already there (by id) are left as they are. */
  inserted: number;
}

/**
 * Creates the sample tables (product, shipment, unit, complaints) and their indexes where
 * missing, then inserts every sample row whose id is not there yet. Idempotent, and it never
 * changes an existing row. These are ordinary data tables: the read-only login may read them.
 */
export async function seedSampleData(database: DatabaseAdapter): Promise<SampleSeedResult[]> {
  const results: SampleSeedResult[] = [];
  for (const table of SAMPLE_TABLES) {
    await createSampleTable(database, table);
    results.push({ table: table.name, inserted: await insertMissingRows(database, table) });
  }
  return results;
}

async function createSampleTable(database: DatabaseAdapter, table: SampleTable): Promise<void> {
  await database.query(`CREATE TABLE IF NOT EXISTS ${table.name} (\n  ${table.definition.join(',\n  ')}\n)`);
  for (const index of table.indexes) {
    await database.ensureIndex({ ...index, table: table.name });
  }
}

async function insertMissingRows(database: DatabaseAdapter, table: SampleTable): Promise<number> {
  const { rows } = await database.query<{ id: number }>(`SELECT id FROM ${table.name}`);
  const existingIds = new Set(rows.map((row) => Number(row.id)));
  const missing = table.rows.filter((row) => !existingIds.has(Number(row.id)));
  for (const row of missing) {
    const columns = Object.keys(row);
    await database.query(
      `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
    );
  }
  return missing.length;
}
