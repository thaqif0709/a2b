// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Runs before `npm run deploy`: stops the deploy when the live database is missing a migration that's in
// migrations/. New code that expects a table or column the database doesn't have yet fails on every request that
// touches it (on 30 Oct the Usage screen, account recovery and address lookups did, until 0015 and 0016 were applied).
// Apply them first: npx wrangler d1 migrations apply a2b --remote
// SKIP_MIGRATION_CHECK=1 npm run deploy skips this, e.g. to roll back code while a migration is still being written.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

if (process.env.SKIP_MIGRATION_CHECK === '1') {
  console.warn('⚠  Migration check skipped (SKIP_MIGRATION_CHECK=1).');
  process.exit(0);
}

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const db = /database_name\s*=\s*"([^"]+)"/.exec(toml)?.[1] ?? 'a2b';

const run = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'list', db, '--remote'], {
  encoding: 'utf8',
  env: { ...process.env, CI: '1' }, // never wait on a prompt
  shell: process.platform === 'win32',
});
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;

if (/No migrations to apply/i.test(out)) {
  console.log(`Database migrations: all applied to ${db}.`);
  process.exit(0);
}

const pending = [...out.matchAll(/\b(\d{4}_[\w-]+\.sql)\b/g)].map((m) => m[1]);
if (/to be applied/i.test(out) && pending.length) {
  console.error(`\n✋ The live database (${db}) is missing ${pending.length === 1 ? 'a migration' : `${pending.length} migrations`}:`);
  for (const name of [...new Set(pending)]) console.error(`   - ${name}`);
  console.error('   The new code needs them. Apply them first, then deploy again:');
  console.error(`   npx wrangler d1 migrations apply ${db} --remote\n`);
  process.exit(1);
}

// Couldn't tell (not logged in, offline, wrangler changed its wording): stop rather than guess.
console.error(`\n✋ Couldn't check the live database's migrations (${db}). wrangler said:\n`);
console.error(out.trim().split('\n').slice(-8).map((l) => `   ${l}`).join('\n'));
console.error('\n   Fix that (npx wrangler login?) and deploy again, or skip the check with SKIP_MIGRATION_CHECK=1.\n');
process.exit(1);
