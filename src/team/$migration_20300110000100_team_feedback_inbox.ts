/** Owner feedback inbox of personas: one row per rated/commented task (team.reflect) — sent to a live session (status sent → reflected/ignored by team.reflectFinish) or queued for the next session's brief (queued → briefed → reflected by team.reportTask); sig dedups repeated identical ratings; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.feedback_inbox (
 id text PRIMARY KEY,
 persona_name text NOT NULL,
 kind text NOT NULL,
 ref_agent_id text NOT NULL DEFAULT '',
 task_id text NOT NULL,
 title text NOT NULL DEFAULT '',
 stars integer,
 comment text NOT NULL DEFAULT '',
 sig text NOT NULL,
 status text NOT NULL,
 to_agent_id text,
 by_user text NOT NULL,
 created_at bigint NOT NULL,
 sent_at bigint,
 briefed_at bigint,
 reflected_at bigint,
 UNIQUE (persona_name, kind, ref_agent_id, task_id)
);
CREATE INDEX IF NOT EXISTS team_feedback_inbox_status_idx ON team.feedback_inbox(persona_name, status);
`});
 }
};
