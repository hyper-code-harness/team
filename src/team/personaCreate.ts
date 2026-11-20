/**
 * Create a persona: a named team member that outlives its sessions
 *
 * The owner (signed-in person) or an agent of the owner's own session (recorded on_behalf_of the owner). Level: scope 'system' (visible in every project, one shared memory) or 'project' (only in projectId); default 'project' when the caller has a project (agents.project_id of the calling session, or opts.projectId from a person), else 'system'. A name is unique among system personas and within a project; a project name may not equal a system name and vice versa (error with a hint). The storage key `name` equals the display name, unless another project already uses it — then the key is "Имя@projectId" and `displayName` stays "Имя". Change the level later with team.personaScope. Writes team.persona and a first 'card' revision. Icon: given svg, else the icon of the latest session whose agents.meta.persona.name equals the name, else null (a letter face is drawn). Exact repeat with the same name and owner returns the existing persona with created:false (no overwrite; change it with team.personaSave). To put the persona into a team use team.create (personas) or team.personaJoin.
 * @param opts.name Display name, unique, e.g. "Ян".
 * @param opts.role Short role, e.g. "ядро".
 * @param opts.responsibilities What the persona is responsible for.
 * @param opts.icon SVG icon; omitted copies the latest session icon of this persona name.
 * @param opts.prompt Starting persona prompt (how it should work).
 * @param opts.notes Starting persona notes (memory).
 * @param opts.plugins Plugin names the persona works with.
 * @param opts.model Default model route for the persona's sessions.
 * @param opts.limits Optional limits, e.g. {promptChars, notesChars}.
 * @param opts.scope Level: 'system' (every project, shared memory) or 'project' (only its project); default 'project' when the caller has a project, else 'system'.
 * @param opts.projectId Project of a project persona (projects.id); default: the caller's project.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Display name, unique, e.g. "Ян". */
        name: string;
        /** Short role, e.g. "ядро". */
        role: string;
        /** What the persona is responsible for. */
        responsibilities?: string;
        /** SVG icon; omitted copies the latest session icon of this persona name. */
        icon?: string;
        /** Starting persona prompt (how it should work). */
        prompt?: string;
        /** Starting persona notes (memory). */
        notes?: string;
        /** Plugin names the persona works with. */
        plugins?: string[];
        /** Default model route for the persona's sessions. */
        model?: string;
        /** Optional limits, e.g. {promptChars, notesChars}. */
        limits?: Record<string, unknown>;
        /** Level: 'system' (every project, shared memory) or 'project' (only its project); default 'project' when the caller has a project, else 'system'. */
        scope?: 'system' | 'project';
        /** Project of a project persona (projects.id); default: the caller's project. */
        projectId?: string;
    },
): Promise<{ name: string; created: boolean; icon: string | null; displayName: string; scope: 'system' | 'project'; projectId: string | null }> {
    type Row = Record<string, any>;
    // The person, or an agent of the person's own session acting on their behalf (persona_rev: author_kind 'agent', on_behalf_of the person).
    const actor = await ctx.fns.team.resolveOwnerActor({}); const ownerId = actor.ownerId;
    const name = String(opts.name ?? '').trim(), role = String(opts.role ?? '').trim();
    if (!name || name.length > 40) throw new Error('personaCreate: name required, ≤40 chars');
    if (!role) throw new Error('personaCreate: role required');
    // Level and project: the calling agent's project, or projectId from a person.
    let callerProject: string | null = null;
    if (actor.kind === 'agent') callerProject = ((await ctx.fns.procs.db.select({ sql: 'SELECT project_id FROM agents WHERE id=?', params: [actor.id] }) as Row[])[0]?.project_id ?? null);
    const scope: 'system' | 'project' = opts.scope ?? ((opts.projectId?.trim() || callerProject) ? 'project' : 'system');
    if (scope !== 'system' && scope !== 'project') throw new Error("personaCreate: scope must be 'system' or 'project'");
    const projectId: string | null = scope === 'project' ? (opts.projectId?.trim() || callerProject) : null;
    if (scope === 'project' && !projectId) throw new Error("personaCreate: scope 'project' needs projectId (this session has no project) — pass projectId or scope: 'system'");
    if (projectId && !(await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM projects WHERE id=?', params: [projectId] }).catch(() => [1])).length) throw new Error('personaCreate: no project ' + projectId);
    const same = await ctx.fns.procs.db.select({ sql: 'SELECT name, owner_user_id, icon, scope, project_id FROM team.persona WHERE display_name=?', params: [name] }) as Row[];
    const twin = same.find(r => r.scope === scope && (r.project_id ?? null) === projectId);
    if (twin) { if (String(twin.owner_user_id) !== ownerId) throw new Error('personaCreate: name taken by another owner'); return { name: String(twin.name), created: false, icon: twin.icon ?? null, displayName: name, scope, projectId }; }
    const sys = same.find(r => r.scope === 'system');
    if (scope === 'project' && sys) throw new Error(`personaCreate: ${name} is already a system persona (visible in every project) — use it as is, or pick another name for the project persona`);
    if (scope === 'system' && same.length) throw new Error(`personaCreate: ${name} is already a project persona of ${same.map(r => r.project_id).join(', ')} — a system name must be free in every project; pick another name or raise it with team.personaScope({ name: '${same[0]!.name}', scope: 'system' })`);
    const key = same.length || (await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM team.persona WHERE name=?', params: [name] })).length ? name + '@' + projectId : name;
    let icon: string | null = opts.icon?.trim() || null;
    if (!icon) { const r = await ctx.fns.procs.db.select({ sql: "SELECT icon FROM agents WHERE meta->'persona'->>'name' = ? AND icon IS NOT NULL ORDER BY created_at DESC LIMIT 1", params: [name] }) as Row[]; icon = r[0]?.icon ?? null; }
    const now = Date.now();
    const card = { role, responsibilities: String(opts.responsibilities ?? '').trim(), icon, plugins: [...new Set((opts.plugins ?? []).map(String).map(s => s.trim()).filter(Boolean))], model: opts.model?.trim() || null, limits: opts.limits ?? {} };
    await ctx.fns.procs.db.transaction({ fn: async () => {
        await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.persona(name,display_name,scope,project_id,owner_user_id,role,responsibilities,icon,prompt,notes,plugins,model,limits,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?::text[],?,?::jsonb,?,?)', params: [key, name, scope, projectId, ownerId, card.role, card.responsibilities, icon, String(opts.prompt ?? ''), String(opts.notes ?? ''), card.plugins, card.model, JSON.stringify(card.limits), now, now] });
        if (actor.onBehalfOf) await ctx.fns.procs.db.run({ sql: "INSERT INTO team.persona_rev(id,persona_name,field,author_kind,author_id,before,after,summary,reason,base_version,at,on_behalf_of) VALUES(?,?,'card','agent',?,'',?,'создана','',0,?,?)", params: [Bun.randomUUIDv7(), key, actor.id, JSON.stringify({ ...card, scope, projectId }), now, actor.onBehalfOf] });
        else await ctx.fns.procs.db.run({ sql: "INSERT INTO team.persona_rev(id,persona_name,field,author_kind,author_id,before,after,summary,reason,base_version,at) VALUES(?,?,'card','user',?,'',?,'создана','',0,?)", params: [Bun.randomUUIDv7(), key, actor.id, JSON.stringify({ ...card, scope, projectId }), now] });
    } });
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { name: key, created: true, icon, displayName: name, scope, projectId };
}
