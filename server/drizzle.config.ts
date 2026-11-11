import { defineConfig } from 'drizzle-kit';

// NOTE: migrations in src/db/migrations are hand-authored SQL (STRICT tables,
// triggers and partial indexes cannot be emitted by drizzle-kit). This config
// exists for `drizzle-kit studio` / `drizzle-kit check` during development.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url: process.env.DATABASE_FILE ?? '../.data/subscriberr.db' },
});
