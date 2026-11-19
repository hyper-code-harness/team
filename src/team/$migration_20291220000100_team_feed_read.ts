/** Read positions in the team chronicle: per agent and manager, the cursor of the last team.feed entry it has read; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.feed_read (
 agent_id text NOT NULL,
 manager_id text NOT NULL,
 cursor text NOT NULL,
 read_at bigint NOT NULL,
 PRIMARY KEY (agent_id, manager_id)
);
`});
 }
};
