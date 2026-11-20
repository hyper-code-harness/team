/** Persona sessions waiting for the owner's review (team.accept closed their last task without a rating): one row per session — the task whose rating (team.rate → team.reflect) sends the session into its last turn and the archive (team.retire); removed by that, by team.retire (fire) or when the session is reused (team.dispatch); idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.review_wait (
 agent_id text PRIMARY KEY,
 persona_name text NOT NULL,
 ref_agent_id text NOT NULL DEFAULT '',
 task_id text NOT NULL,
 title text NOT NULL DEFAULT '',
 created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS team_review_wait_task_idx ON team.review_wait(ref_agent_id, task_id);
`});
 }
};
