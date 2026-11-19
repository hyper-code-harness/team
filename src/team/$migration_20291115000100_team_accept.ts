/** Owner acceptance marks for delegated child plan tasks (review -> history); idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.accept (
 agent_id text NOT NULL,
 task_id text NOT NULL,
 accepted_by text NOT NULL,
 accepted_at bigint NOT NULL,
 PRIMARY KEY (agent_id, task_id)
);
`});
 }
};
