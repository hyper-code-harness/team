/** Questions between personas (team.ask / team.answer): one row per question — who asked whom, the live session it went to or the consultant mode, the single answer; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.ask (
 id text PRIMARY KEY,
 from_agent_id text NOT NULL,
 from_name text NOT NULL,
 to_persona text NOT NULL,
 to_agent_id text,
 mode text NOT NULL,
 task_id text,
 task_title text NOT NULL DEFAULT '',
 question text NOT NULL,
 status text NOT NULL DEFAULT 'asked',
 answer text,
 answered_by text,
 created_at bigint NOT NULL,
 answered_at bigint
);
CREATE INDEX IF NOT EXISTS team_ask_to_idx ON team.ask(to_agent_id, status);
CREATE INDEX IF NOT EXISTS team_ask_from_idx ON team.ask(from_agent_id, status);
`});
 }
};
