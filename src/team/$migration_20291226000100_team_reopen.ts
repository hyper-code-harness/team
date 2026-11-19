/** Reopen marks: an owner (or manager) returned a finished task to work with a comment (team.reopen). agent_id is '' for team tasks; new_agent_id / new_task_id point at the continuation when the old assignee could not take it back; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.reopen (
 id text PRIMARY KEY,
 agent_id text NOT NULL DEFAULT '',
 task_id text NOT NULL,
 comment text NOT NULL,
 action text NOT NULL,
 to_agent_id text NOT NULL DEFAULT '',
 new_agent_id text NOT NULL DEFAULT '',
 new_task_id text NOT NULL DEFAULT '',
 next_idx integer,
 by_actor text NOT NULL,
 at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS team_reopen_task_idx ON team.reopen (agent_id, task_id, at);
CREATE INDEX IF NOT EXISTS team_reopen_new_idx ON team.reopen (new_agent_id) WHERE new_agent_id <> '';
`});
 }
};
