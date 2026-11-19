/** Shared team feed: short notes agents post for everyone (team.post); idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.post (
 id text PRIMARY KEY,
 author_kind text NOT NULL,
 author_id text NOT NULL,
 team_id text,
 task_id text,
 kind text NOT NULL DEFAULT 'note',
 text text NOT NULL,
 created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS team_post_created_idx ON team.post (created_at DESC);
`});
 }
};
