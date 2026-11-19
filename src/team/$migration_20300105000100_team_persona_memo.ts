/** Persona memory as many memos: team.persona_memo (persona, path, title, description, content, soft delete), persona_rev learns field 'memo' with path + meta; non-empty persona.notes move into memo notes/legacy.md; sessions started by team.delegate outside a team get their persona_session row; idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
CREATE TABLE IF NOT EXISTS team.persona_memo (
 persona_name text NOT NULL REFERENCES team.persona(name) ON DELETE CASCADE,
 path text NOT NULL,
 title text NOT NULL,
 description text NOT NULL DEFAULT '',
 content text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL,
 deleted_at bigint,
 PRIMARY KEY (persona_name, path)
);
ALTER TABLE team.persona_rev ADD COLUMN IF NOT EXISTS path text;
ALTER TABLE team.persona_rev ADD COLUMN IF NOT EXISTS meta jsonb;
ALTER TABLE team.persona_rev DROP CONSTRAINT IF EXISTS persona_rev_field_check;
ALTER TABLE team.persona_rev ADD CONSTRAINT persona_rev_field_check CHECK (field = ANY (ARRAY['prompt','notes','card','memo']));
CREATE INDEX IF NOT EXISTS team_persona_rev_memo_idx ON team.persona_rev(persona_name, path, at DESC) WHERE field = 'memo';
CREATE INDEX IF NOT EXISTS team_persona_rev_author_idx ON team.persona_rev(author_id, at DESC);
INSERT INTO team.persona_memo(persona_name, path, title, description, content, version, created_at, updated_at)
 SELECT name, 'notes/legacy.md', 'Старые заметки', 'Перенесено из поля notes; разнеси по темам и удали лишнее', notes, 1, (extract(epoch from now())*1000)::bigint, (extract(epoch from now())*1000)::bigint
 FROM team.persona WHERE btrim(notes) <> ''
 ON CONFLICT DO NOTHING;
INSERT INTO team.persona_session(agent_id, persona_name, team_id, started_at)
 SELECT a.id, a.meta->'persona'->>'name', NULL, a.created_at FROM agents a
 JOIN team.persona p ON p.name = a.meta->'persona'->>'name'
 WHERE a.meta ? 'persona'
 ON CONFLICT (agent_id) DO NOTHING;
`});
 }
};
