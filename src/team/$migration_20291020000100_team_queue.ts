/** Additive backlog/queue columns and the paused status for team.task; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS rank double precision;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS group_key text;
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS depends_on text[] NOT NULL DEFAULT '{}';
ALTER TABLE team.task ADD COLUMN IF NOT EXISTS paused_note text;
ALTER TABLE team.task DROP CONSTRAINT IF EXISTS task_status_check;
ALTER TABLE team.task ADD CONSTRAINT task_status_check CHECK(status IN ('todo','assigned','working','blocked','paused','review','done','cancelled'));
ALTER TABLE team.task DROP CONSTRAINT IF EXISTS task_paused_assignee_check;
ALTER TABLE team.task ADD CONSTRAINT task_paused_assignee_check CHECK(status <> 'paused' OR assignee_agent_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS team_task_queue ON team.task(team_id,assignee_agent_id,rank);
`});
 }
};
