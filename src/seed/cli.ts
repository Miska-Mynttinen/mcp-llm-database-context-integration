import { connectDatabaseAdapter, type DatabaseAdapter, readReadOnlyLoginFromEnv } from '@mcp-llm/database';
import { loadConfigEnvFiles } from '../config/envFiles';
import { readSeedConfig, seedFromConfig } from '../auth';
import { openAppStorage } from '../storage/appStorage';
import { seedSampleData } from './seedSampleData';

const SAMPLE_DATA_FLAG = '--sample-data';
const RESET_PASSWORD_FLAG = '--reset-password';

/**
 * CLI: `npm run seed [-- --sample-data] [-- --reset-password]`, on the database the DB_* settings
 * name (SQLite, PostgreSQL or MySQL).
 * - `--sample-data` creates and fills the sample tables product, shipment, unit and complaints.
 * - Always creates the app tables, and the read-only login when DB_READONLY_USER is set.
 * - Seeds user1…user5 when SEED_USER_PASSWORD is set; `--reset-password` also resets their passwords.
 */
async function main(args: readonly string[]): Promise<void> {
  loadConfigEnvFiles();
  const withSampleData = args.includes(SAMPLE_DATA_FLAG);
  const seedConfig = readSeedConfig();
  if (!seedConfig.password && !withSampleData) {
    throw new Error(`Set SEED_USER_PASSWORD to seed users, or pass ${SAMPLE_DATA_FLAG} to seed only the sample data`);
  }
  const readOnlyLogin = readReadOnlyLoginFromEnv();
  const database = await connectDatabaseAdapter();
  try {
    // Before the read-only login is granted: on MySQL it can only read the tables that exist by then.
    if (withSampleData) {
      await seedSamples(database);
    }
    const { users } = await openAppStorage(database, { readOnlyLogin });
    if (readOnlyLogin) {
      console.log(`Read-only login ${readOnlyLogin.user}: can read every table but the app tables`);
    }
    if (!seedConfig.password) {
      console.log('SEED_USER_PASSWORD is not set: no users seeded');
      return;
    }
    const results = await seedFromConfig(users, seedConfig, { resetPassword: args.includes(RESET_PASSWORD_FLAG) });
    for (const { username, outcome } of results) {
      console.log(`${username}: ${outcome}`);
    }
    console.log(`Seeded ${results.length} users into ${database.getDatabaseType()}`);
  } finally {
    await database.disconnect();
  }
}

async function seedSamples(database: DatabaseAdapter): Promise<void> {
  for (const { table, inserted } of await seedSampleData(database)) {
    console.log(`${table}: ${inserted} rows inserted`);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`Seeding failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
