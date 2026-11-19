/** Revision reason/base_version and team.task_link: plan task of a persona session -> team task it works on; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
ALTER TABLE team.persona_rev ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '';
ALTER TABLE team.persona_rev ADD COLUMN IF NOT EXISTS base_version integer;
CREATE TABLE IF NOT EXISTS team.task_link (
 agent_id text NOT NULL,
 plan_task_id text NOT NULL,
 team_id text NOT NULL,
 task_id text NOT NULL,
 persona_name text,
 created_at bigint NOT NULL,
 PRIMARY KEY(agent_id, plan_task_id)
);
CREATE INDEX IF NOT EXISTS team_task_link_task_idx ON team.task_link(team_id, task_id);`});
 }
};
