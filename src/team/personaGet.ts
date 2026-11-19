/**
 * Read one persona with its live session, recent revisions and recent tasks
 *
 * Look up by name, or by agentId of any of its sessions (current or past, via team.persona_session). Owner (signed-in person) or any agent may read; the persona is a team-wide passport, not a secret. Includes the persona's live memos (path, title, description, text, version, updatedAt; team.persona_memo) — the persona's memory; `notes` is the old single-text field kept for history. Returns null when nothing matches.
 * @param opts.name Persona name, e.g. "Ян".
 * @param opts.agentId Any session id of the persona (current_agent_id or a past session).
 * @param opts.revisions How many latest revisions to include. @default 10 @minimum 0 @maximum 100
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona name, e.g. "Ян". */
        name?: string;
        /** Any session id of the persona (current_agent_id or a past session). */
        agentId?: string;
        /** How many latest revisions to include. @default 10 @minimum 0 @maximum 100 */
        revisions?: number;
    },
): Promise<{name:string;ownerUserId:string;role:string;responsibilities:string;icon:string|null;prompt:string;notes:string;plugins:string[];model:string|null;limits:Record<string,unknown>;currentAgentId:string|null;version:number;createdAt:number;updatedAt:number;teams:string[];sessions:Array<{agentId:string;teamId:string|null;startedAt:number;endedAt:number|null}>;memos:Array<{path:string;title:string;description:string;content:string;version:number;updatedAt:number}>;revisions:Array<{id:string;field:string;path:string|null;authorKind:string;authorId:string;summary:string;before:string;after:string;revertOf:string|null;at:number}>}|null> {
    type Row = Record<string, any>;
    let name = String(opts.name ?? '').trim();
    if (!name && opts.agentId?.trim()) {
        const r = await ctx.fns.procs.db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [opts.agentId.trim(), opts.agentId.trim()] }) as Row[];
        name = String(r[0]?.name ?? '');
    }
    if (!name) return null;
    const rows = await ctx.fns.procs.db.select({ sql: 'SELECT * FROM team.persona WHERE name=?', params: [name] }) as Row[];
    const p = rows[0]; if (!p) return null;
    const n = Math.max(0, Math.min(100, Number(opts.revisions ?? 10)));
    const [teams = [], sessions = [], revs = [], memos = []] = await Promise.all([
        ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.team_persona WHERE persona_name=? AND active ORDER BY joined_at', params: [name] }),
        ctx.fns.procs.db.select({ sql: 'SELECT agent_id,team_id,started_at,ended_at FROM team.persona_session WHERE persona_name=? ORDER BY started_at DESC LIMIT 20', params: [name] }),
        n ? ctx.fns.procs.db.select({ sql: 'SELECT * FROM team.persona_rev WHERE persona_name=? ORDER BY at DESC, id DESC LIMIT ?', params: [name, n] }) : Promise.resolve([]),
        ctx.fns.procs.db.select({ sql: 'SELECT path,title,description,content,version,updated_at FROM team.persona_memo WHERE persona_name=? AND deleted_at IS NULL ORDER BY path', params: [name] }),
    ]) as Row[][];
    return {
        name: String(p.name), ownerUserId: String(p.owner_user_id), role: String(p.role), responsibilities: String(p.responsibilities),
        icon: p.icon ?? null, prompt: String(p.prompt), notes: String(p.notes), plugins: Array.isArray(p.plugins) ? p.plugins.map(String) : [],
        model: p.model ?? null, limits: (typeof p.limits === 'string' ? JSON.parse(p.limits) : p.limits) ?? {}, currentAgentId: p.current_agent_id ?? null,
        version: Number(p.version), createdAt: Number(p.created_at), updatedAt: Number(p.updated_at),
        teams: teams.map(r => String(r.team_id)),
        sessions: sessions.map(r => ({ agentId: String(r.agent_id), teamId: r.team_id ?? null, startedAt: Number(r.started_at), endedAt: r.ended_at == null ? null : Number(r.ended_at) })),
        memos: memos.map(r => ({ path: String(r.path), title: String(r.title), description: String(r.description), content: String(r.content), version: Number(r.version), updatedAt: Number(r.updated_at) })),
        revisions: revs.map(r => ({ id: String(r.id), field: String(r.field), path: r.path ?? null, authorKind: String(r.author_kind), authorId: String(r.author_id), summary: String(r.summary), before: String(r.before), after: String(r.after), revertOf: r.revert_of ?? null, at: Number(r.at) })),
    };
}
