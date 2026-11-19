/** Persistent personas: a team member is a persona (name, role, prompt, notes, plugins), its live session is a replaceable current_agent_id. persona_rev keeps every prompt/notes/card change for history and rollback. team_persona is the team roster of personas; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.persona (
 name text PRIMARY KEY,
 owner_user_id text NOT NULL,
 role text NOT NULL DEFAULT '',
 responsibilities text NOT NULL DEFAULT '',
 icon text,
 prompt text NOT NULL DEFAULT '',
 notes text NOT NULL DEFAULT '',
 plugins text[] NOT NULL DEFAULT '{}',
 model text,
 limits jsonb NOT NULL DEFAULT '{}'::jsonb,
 current_agent_id text,
 version integer NOT NULL DEFAULT 1,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS team_persona_agent_idx ON team.persona(current_agent_id);
CREATE TABLE IF NOT EXISTS team.persona_rev (
 id text PRIMARY KEY,
 persona_name text NOT NULL REFERENCES team.persona(name) ON DELETE CASCADE,
 field text NOT NULL CHECK(field IN ('prompt','notes','card')),
 author_kind text NOT NULL CHECK(author_kind IN ('user','agent')),
 author_id text NOT NULL,
 before text NOT NULL DEFAULT '',
 after text NOT NULL DEFAULT '',
 summary text NOT NULL DEFAULT '',
 revert_of text,
 at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS team_persona_rev_idx ON team.persona_rev(persona_name, at DESC);
CREATE TABLE IF NOT EXISTS team.team_persona (
 team_id text NOT NULL REFERENCES team.team(id) ON DELETE CASCADE,
 persona_name text NOT NULL REFERENCES team.persona(name),
 active boolean NOT NULL DEFAULT true,
 joined_at bigint NOT NULL,
 left_at bigint,
 PRIMARY KEY(team_id, persona_name)
);
CREATE TABLE IF NOT EXISTS team.persona_session (
 agent_id text PRIMARY KEY,
 persona_name text NOT NULL REFERENCES team.persona(name) ON DELETE CASCADE,
 team_id text,
 started_at bigint NOT NULL,
 ended_at bigint
);
CREATE INDEX IF NOT EXISTS team_persona_session_name_idx ON team.persona_session(persona_name, started_at DESC);

`});
 }
};
