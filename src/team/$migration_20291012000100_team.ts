/** Dedicated team domain storage; never writes core session or agent tables. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE SCHEMA IF NOT EXISTS team;
CREATE TABLE IF NOT EXISTS team.team (
 id text PRIMARY KEY, owner_user_id text NOT NULL, title text NOT NULL, goal text NOT NULL,
 supervisor_agent_id text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
 version integer NOT NULL DEFAULT 1, next_seq bigint NOT NULL DEFAULT 0,
 progress_window_ms bigint NOT NULL DEFAULT 3600000 CHECK(progress_window_ms BETWEEN 1000 AND 86400000),
 created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS team.member (
 team_id text NOT NULL REFERENCES team.team(id), agent_id text NOT NULL,
 role text NOT NULL, responsibilities text NOT NULL, active boolean NOT NULL DEFAULT false,
 PRIMARY KEY(team_id,agent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS team_member_active_agent ON team.member(agent_id) WHERE active;
CREATE TABLE IF NOT EXISTS team.task (
 id text PRIMARY KEY, team_id text NOT NULL REFERENCES team.team(id), title text NOT NULL,
 instructions text NOT NULL, acceptance_criteria text NOT NULL,
 assignee_agent_id text, status text NOT NULL CHECK(status IN ('todo','assigned','working','blocked','review','done','cancelled')),
 version integer NOT NULL DEFAULT 1, ever_started_at bigint, current_submission_id text,
 blocked_reason text, progress_due_at bigint, last_progress_at bigint, deadline_generation integer NOT NULL DEFAULT 0,
 UNIQUE(team_id,id), FOREIGN KEY(team_id,assignee_agent_id) REFERENCES team.member(team_id,agent_id),
 CHECK(status NOT IN ('assigned','working','blocked','review','done') OR assignee_agent_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS team_task_work_slot ON team.task(team_id,assignee_agent_id) WHERE status IN ('working','blocked');
CREATE TABLE IF NOT EXISTS team.event (
 id text PRIMARY KEY, team_id text NOT NULL REFERENCES team.team(id), seq bigint NOT NULL,
 task_id text, actor_kind text NOT NULL CHECK(actor_kind IN ('user','agent','system')), actor_id text NOT NULL,
 kind text NOT NULL, text text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
 causation_id text, command_key text, timestamp bigint NOT NULL,
 UNIQUE(team_id,seq), UNIQUE(team_id,id), FOREIGN KEY(team_id,task_id) REFERENCES team.task(team_id,id)
);
CREATE TABLE IF NOT EXISTS team.command (
 team_id text NOT NULL REFERENCES team.team(id), actor_kind text NOT NULL CHECK(actor_kind IN ('user','agent')),
 actor_id text NOT NULL, request_key text NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(team_id,actor_kind,actor_id,request_key)
);
CREATE TABLE IF NOT EXISTS team.delivery (
 id text PRIMARY KEY, team_id text NOT NULL REFERENCES team.team(id), event_id text NOT NULL,
 recipient_agent_id text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','delivered','failed')),
 claim_token text, lease_until bigint, attempts integer NOT NULL DEFAULT 0, next_at bigint NOT NULL,
 receipt jsonb, last_error text,
 UNIQUE(event_id,recipient_agent_id), FOREIGN KEY(team_id,event_id) REFERENCES team.event(team_id,id),
 FOREIGN KEY(team_id,recipient_agent_id) REFERENCES team.member(team_id,agent_id)
);
CREATE INDEX IF NOT EXISTS team_delivery_due ON team.delivery(status,next_at);
CREATE INDEX IF NOT EXISTS team_task_deadlines ON team.task(progress_due_at) WHERE progress_due_at IS NOT NULL;
`});
 }
};
