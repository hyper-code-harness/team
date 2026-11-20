/**
 * Change a persona's level: system (every project, shared memory) ↔ project (only its project), or move it to another project
 *
 * Owner of the persona only (signed-in person, or — via team.resolveOwnerActor when present — an agent of the owner's session). Checks name clashes: a system persona's display name must be free in every project; a project one must not equal a system name nor another persona of that project. projectId defaults to the caller's project for scope 'project'. The storage key (name) does not change, memory and history stay. Writes a persona_rev row field='scope' (before/after JSON). Same level and project again → changed:false.
 * @param opts.name Persona (storage key or display name).
 * @param opts.scope New level: 'system' or 'project'.
 * @param opts.projectId Project for scope 'project' (projects.id); default: the caller's project.
 * @param opts.reason Why the level changes (kept in the revision).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona (storage key or display name). */
        name: string;
        /** New level: 'system' or 'project'. */
        scope: 'system' | 'project';
        /** Project for scope 'project' (projects.id); default: the caller's project. */
        projectId?: string;
        /** Why the level changes (kept in the revision). */
        reason?: string;
    },
): Promise<{ name: string; displayName: string; scope: 'system' | 'project'; projectId: string | null; changed: boolean }> {
    type Row = Record<string, any>;
    const db = ctx.fns.procs.db;
    const fns = ctx.fns.team as Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    let ownerId = actor.id, onBehalfOf: string | null = null;
    if (actor.kind === 'agent') {
        if (typeof fns.resolveOwnerActor !== 'function') throw new Error('personaScope: owner (signed-in person) only — смену уровня делает человек на /team/');
        const o = await fns.resolveOwnerActor({}); ownerId = String(o.ownerId); onBehalfOf = o.onBehalfOf ?? null;
    }
    const scope = opts.scope;
    if (scope !== 'system' && scope !== 'project') throw new Error("personaScope: scope must be 'system' or 'project'");
    const raw = String(opts.name ?? '').trim();
    if (!raw) throw new Error('personaScope: name required');
    let callerProject: string | null = null;
    if (actor.kind === 'agent') callerProject = ((await db.select({ sql: 'SELECT project_id FROM agents WHERE id=?', params: [actor.id] }) as Row[])[0]?.project_id ?? null);
    const projectId: string | null = scope === 'project' ? (opts.projectId?.trim() || callerProject) : null;
    if (scope === 'project' && !projectId) throw new Error("personaScope: scope 'project' needs projectId (this session has no project)");
    if (projectId && !(await db.select({ sql: 'SELECT 1 FROM projects WHERE id=?', params: [projectId] }).catch(() => [1])).length) throw new Error('personaScope: no project ' + projectId);
    type Out = { name: string; displayName: string; scope: 'system' | 'project'; projectId: string | null; changed: boolean };
    return await db.transaction({ fn: async (): Promise<Out> => {
        let rows = await db.select({ sql: 'SELECT * FROM team.persona WHERE name=? FOR UPDATE', params: [raw] }) as Row[];
        if (!rows.length) {
            rows = await db.select({ sql: 'SELECT * FROM team.persona WHERE display_name=? FOR UPDATE', params: [raw] }) as Row[];
            if (rows.length > 1) throw new Error(`personaScope: ${raw} is ambiguous — pass the key: ${rows.map(r => r.name).join(', ')}`);
        }
        const p = rows[0];
        if (!p) throw new Error('personaScope: no persona ' + raw);
        if (String(p.owner_user_id) !== ownerId) throw new Error('personaScope: only the persona owner changes its level');
        const display = String(p.display_name ?? p.name);
        const before = { scope: String(p.scope ?? 'system'), projectId: p.project_id ?? null };
        if (before.scope === scope && before.projectId === projectId) return { name: String(p.name), displayName: display, scope, projectId, changed: false };
        const others = (await db.select({ sql: 'SELECT name, scope, project_id FROM team.persona WHERE display_name=? AND name<>?', params: [display, p.name] }) as Row[]);
        if (scope === 'system' && others.length) throw new Error(`personaScope: ${display} cannot become system — the name is used by ${others.map(r => r.scope === 'project' ? 'project ' + r.project_id : 'a system persona').join(', ')}; rename one of them first`);
        if (scope === 'project') {
            const clash = others.find(r => r.scope === 'system' || String(r.project_id) === projectId);
            if (clash) throw new Error(`personaScope: ${display} clashes with ${clash.scope === 'system' ? 'a system persona' : 'a persona of project ' + projectId} of the same name`);
        }
        const now = Date.now();
        await db.run({ sql: 'UPDATE team.persona SET scope=?, project_id=?, version=version+1, updated_at=? WHERE name=?', params: [scope, projectId, now, p.name] });
        await db.run({ sql: "INSERT INTO team.persona_rev(id,persona_name,field,author_kind,author_id,before,after,summary,reason,base_version,at) VALUES(?,?,'scope',?,?,?,?,?,?,?,?)", params: [Bun.randomUUIDv7(), p.name, actor.kind, actor.id, JSON.stringify(before), JSON.stringify({ scope, projectId, ...(onBehalfOf ? { onBehalfOf } : {}) }), scope === 'system' ? 'уровень: системная' : 'уровень: проект ' + projectId, String(opts.reason ?? ''), Number(p.version), now] });
        try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
        return { name: String(p.name), displayName: display, scope, projectId, changed: true };
    } }) as Out;
}
