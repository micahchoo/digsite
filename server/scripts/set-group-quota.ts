// Sets one group's storage quota (storage/quota.ts), or clears it back to
// the operator default (GROUP_QUOTA_GB). An operator decision, so a script
// and never a route.
//
//   bun run scripts/set-group-quota.ts <groupId> <GB | default>
import { pool } from '../src/db/pool.ts';
import { storageOf } from '../src/storage/quota.ts';

const [orgId, amount] = process.argv.slice(2);
if (!orgId || !amount) {
  console.error('usage: set-group-quota.ts <groupId> <GB | default>');
  process.exit(2);
}
const quota = amount === 'default' ? null : Math.round(Number(amount) * 1e9);
if (quota !== null && !(quota >= 0)) {
  console.error(`not a number of GB: ${amount}`);
  process.exit(2);
}
await pool.query(
  `INSERT INTO group_storage (org_id, quota_bytes) VALUES ($1, $2)
   ON CONFLICT (org_id) DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes`,
  [orgId, quota],
);
console.log(orgId, await storageOf(orgId));
await pool.end();
