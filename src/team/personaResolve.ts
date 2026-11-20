/**
 * Find a persona by name as the caller sees it: system personas plus project personas of the caller's project
 *
 * Caller's project = opts.projectId, else agents.project_id of the calling agent session; a person without projectId sees every project. Matches display_name or the storage key name. A project persona of a different project throws «persona X belongs to project Y». Several matches for a person without projectId throw and ask for projectId. No side effects; returns null when nothing matches. Use the returned name (storage key) in every other team call.
 * @param opts.name Persona name as shown (display name) or its storage key, e.g. "Ян" or "Ян@r".
 * @param opts.projectId Project to look from (projects.id); default: the calling agent's project.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona name as shown (display name) or its storage key, e.g. "Ян" or "Ян@r". */
        name: string;
        /** Project to look from (projects.id); default: the calling agent's project. */
        projectId?: string;
    },
): Promise<{ name: string; displayName: string; scope: 'system' | 'project'; projectId: string | null; projectTitle: string | null; callerProjectId: string | null } | null> {
    type Row = Record<string, any>;
    const db = ctx.fns.procs.db;
    const name = String(opts.name ?? '').trim();
    if (!name) return null;
    let caller: string | null = opts.projectId?.trim() || null;
    if (!caller && (session?.agent || session?.agentId)) {
        try { const id = (await ctx.fns.agent.current({})).id; caller = ((await db.select({ sql: 'SELECT project_id FROM agents WHERE id=?', params: [id] }) as Row[])[0]?.project_id ?? null); } catch { caller = null; }
    }
    const rows = await db.select({ sql: 'SELECT p.name, p.display_name, p.scope, p.project_id, pr.title AS project_title FROM team.persona p LEFT JOIN projects pr ON pr.id = p.project_id WHERE p.display_name = ? OR p.name = ? ORDER BY (p.name = ?) DESC, p.scope DESC', params: [name, name, name] }).catch(async () =>
        db.select({ sql: 'SELECT p.name, p.display_name, p.scope, p.project_id, NULL AS project_title FROM team.persona p WHERE p.display_name = ? OR p.name = ? ORDER BY (p.name = ?) DESC, p.scope DESC', params: [name, name, name] })) as Row[];
    const out = (r: Row) => ({ name: String(r.name), displayName: String(r.display_name ?? r.name), scope: (r.scope === 'project' ? 'project' : 'system') as 'system' | 'project', projectId: r.project_id ?? null, projectTitle: r.project_title ?? null, callerProjectId: caller });
    if (!rows.length) return null;
    const exact = rows.find(r => String(r.name) === name && (r.scope !== 'project' || !caller || String(r.project_id) === caller));
    if (exact) return out(exact);
    if (caller) {
        const mine = rows.find(r => r.scope === 'project' && String(r.project_id) === caller) ?? rows.find(r => r.scope !== 'project');
        if (mine) return out(mine);
        const f = rows[0]!;
        throw new Error(`persona ${name} belongs to project ${f.project_id}${f.project_title ? ' (' + f.project_title + ')' : ''} — this session is in project ${caller}; use a system persona or one of project ${caller} (team.personas)`);
    }
    if (rows.length === 1) return out(rows[0]!);
    throw new Error(`persona ${name} is ambiguous: ${rows.map(r => r.scope === 'project' ? 'project ' + r.project_id : 'system').join(', ')} — pass projectId or the key (${rows.map(r => r.name).join(', ')})`);
}
