/** Owner actions on report "Дальше" items (team.next) and owner ratings of finished tasks (team.rating); idempotent. agent_id is '' for team-plugin tasks, the child id for delegated plan tasks. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.next (
 agent_id text NOT NULL DEFAULT '',
 task_id text NOT NULL,
 idx integer NOT NULL,
 kind text NOT NULL,
 title text NOT NULL,
 action text NOT NULL,
 result jsonb NOT NULL DEFAULT '{}'::jsonb,
 by_user text NOT NULL,
 at bigint NOT NULL,
 PRIMARY KEY (agent_id, task_id, idx)
);
CREATE TABLE IF NOT EXISTS team.rating (
 agent_id text NOT NULL DEFAULT '',
 task_id text NOT NULL,
 assignee_agent_id text NOT NULL,
 stars integer NOT NULL CHECK (stars BETWEEN 1 AND 5),
 comment text NOT NULL DEFAULT '',
 rated_by text NOT NULL,
 rated_at bigint NOT NULL,
 PRIMARY KEY (agent_id, task_id)
);
CREATE INDEX IF NOT EXISTS team_rating_assignee_idx ON team.rating (assignee_agent_id);
`});
 }
};
