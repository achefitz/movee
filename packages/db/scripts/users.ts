/**
 * Newest sign-ups with a little activity summary.
 *   pnpm db:users          (latest 50)
 *   pnpm db:users 200      (latest 200)
 */
import { config } from 'dotenv';
config({ path: '../../.env' });

const limit = Math.max(1, Math.min(1000, Number(process.argv[2]) || 50));
const { pool } = await import('../src/index');

const { rows: [totals] } = await pool.query(`
  select count(*)::int as total,
         count(*) filter (where created_at > now() - interval '1 day')::int as last_24h,
         count(*) filter (where created_at > now() - interval '7 days')::int as last_7d
  from users`);
console.log(`Accounts: ${totals.total} total · ${totals.last_24h} in the last 24h · ${totals.last_7d} in the last 7 days\n`);

const { rows } = await pool.query(`
  select u.username,
         to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as joined_utc,
         u.onboarded_at is not null as onboarded,
         u.is_private as private,
         (select count(*) from recs_interactions i where i.user_id = u.id)::int as swipes,
         (select count(*) from friends f where f.friend_id = u.id and f.status = 'accepted')::int as followers,
         (select max(expires_at) from sessions s where s.user_id = u.id) as session_expires
  from users u
  order by u.created_at desc
  limit $1`, [limit]);
console.table(rows.map(r => ({ ...r, session_expires: r.session_expires ? new Date(r.session_expires).toISOString().slice(0, 10) : '—' })));
await pool.end();
