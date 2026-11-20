/** Persona levels: team.persona.scope 'system' (any project, shared memory) or 'project' (only its project_id); display_name is the shown name (a trigger fills it with name when omitted) — name stays the storage key (FKs), a project persona whose name is taken gets the key "Имя@projectId". Unique display_name among system personas and per (project_id, display_name) among project ones; system↔project clashes are checked in code. Additive, idempotent. */
export default {
 async up(ctx: Context) {
  await ctx.fns.procs.db.exec({sql: `
ALTER TABLE team.persona ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'system';
ALTER TABLE team.persona ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE team.persona ADD COLUMN IF NOT EXISTS display_name text;
UPDATE team.persona SET display_name = name WHERE display_name IS NULL;
CREATE OR REPLACE FUNCTION team.persona_display_name() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.display_name IS NULL OR btrim(NEW.display_name) = '' THEN NEW.display_name := NEW.name; END IF; RETURN NEW; END $f$;
DROP TRIGGER IF EXISTS team_persona_display_name ON team.persona;
CREATE TRIGGER team_persona_display_name BEFORE INSERT OR UPDATE ON team.persona FOR EACH ROW EXECUTE FUNCTION team.persona_display_name();
ALTER TABLE team.persona ALTER COLUMN display_name SET NOT NULL;
ALTER TABLE team.persona DROP CONSTRAINT IF EXISTS persona_scope_check;
ALTER TABLE team.persona ADD CONSTRAINT persona_scope_check CHECK (scope IN ('system','project') AND (scope = 'project') = (project_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS team_persona_system_name_uq ON team.persona(display_name) WHERE scope = 'system';
CREATE UNIQUE INDEX IF NOT EXISTS team_persona_project_name_uq ON team.persona(project_id, display_name) WHERE scope = 'project';
ALTER TABLE team.persona_rev DROP CONSTRAINT IF EXISTS persona_rev_field_check;
ALTER TABLE team.persona_rev ADD CONSTRAINT persona_rev_field_check CHECK (field = ANY (ARRAY['prompt','notes','card','memo','scope']));`});
 }
};
