/**
 * Owner ratings (team.rating) grouped by persona or by session, by default only the caller's team
 *
 * Read-only. For the passport or hiring: how the owner rated handed-in tasks (1–5 stars, see team.rate). groupBy 'persona' (default) sums every session of a persona (team.persona_session, persona.current_agent_id) into one row: avg, count, sessions and the latest ratings with comments; executors that are not persona sessions get a row with persona null. groupBy 'session' gives the old one row per executor agent in `agents`. Scope: with agentId or persona the filter is explicit and scope is ignored; otherwise an agent caller gets 'team' by default — its delegated children (parent_id = caller), its siblings (children of its parent), members and supervisor of team-plugin teams it belongs to or supervises, plus every session of the personas among them; a signed-in person (the /team/ UI) gets 'all' by default. scope 'all' = every rating, as before. Missing tables = no ratings yet.
 * @param opts.agentId Executor agent id: only that session's ratings (rolled into its persona when groupBy is persona).
 * @param opts.persona Persona name: only ratings of that persona's sessions.
 * @param opts.groupBy 'persona' (default): one row per persona; 'session': one row per executor agent.
 * @param opts.scope 'team': only the caller's team; 'all': every rating. Default: 'team' for an agent caller, 'all' for a person.
 * @param opts.recent How many latest ratings to include per row. @default 5 @minimum 0 @maximum 50
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Executor agent id: only that session's ratings (rolled into its persona when groupBy is persona). */
        agentId?: string;
        /** Persona name: only ratings of that persona's sessions. */
        persona?: string;
        /** 'persona' (default): one row per persona; 'session': one row per executor agent. */
        groupBy?: 'persona' | 'session';
        /** 'team': only the caller's team; 'all': every rating. Default: 'team' for an agent caller, 'all' for a person. */
        scope?: 'team' | 'all';
        /** How many latest ratings to include per row. @default 5 @minimum 0 @maximum 50 */
        recent?: number;
    },
): Promise<{
    groupBy: 'persona' | 'session';
    /** Effective scope: 'filter' when agentId/persona was given. */
    scope: 'team' | 'all' | 'filter';
    /** groupBy 'persona': one row per persona (persona null = executor outside any persona), most rated first. */
    personas: Array<{ persona: string | null; agentIds: string[]; count: number; avg: number; recent: Array<{ taskId: string; agentId: string; childAgentId: string | null; stars: number; comment: string; at: number }> }>;
    /** groupBy 'session': one row per executor agent, most rated first. */
    agents: Array<{ agentId: string; persona: string | null; count: number; avg: number; recent: Array<{ taskId: string; childAgentId: string | null; stars: number; comment: string; at: number }> }>;
}> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    const missing = (e: unknown) => /does not exist/.test(String(e));
    const sel = async (sql: string, params: unknown[] = []): Promise<Row[]> => { try { return await ctx.fns.procs.db.select({ sql, params }) as Row[]; } catch (e) { if (missing(e)) return []; throw e; } };
    const agentId = String(opts.agentId ?? '').trim();
    const persona = String(opts.persona ?? '').trim();
    const groupBy = opts.groupBy ?? 'persona';
    if (groupBy !== 'persona' && groupBy !== 'session') throw new Error("team.ratings: groupBy must be 'persona' or 'session'");
    if (opts.scope !== undefined && opts.scope !== 'team' && opts.scope !== 'all') throw new Error("team.ratings: scope must be 'team' or 'all'");
    const recent = Math.max(0, Math.min(50, Number(opts.recent ?? 5) || 0));
    const scope: 'team' | 'all' | 'filter' = agentId || persona ? 'filter' : (opts.scope ?? (actor.kind === 'agent' ? 'team' : 'all'));

    // ---- persona of every session
    const personaOf = new Map<string, string>();
    for (const r of await sel('SELECT agent_id, persona_name FROM team.persona_session')) personaOf.set(String(r.agent_id), String(r.persona_name));
    for (const r of await sel('SELECT name, current_agent_id FROM team.persona WHERE current_agent_id IS NOT NULL')) if (!personaOf.has(String(r.current_agent_id))) personaOf.set(String(r.current_agent_id), String(r.name));
    const sessionsOf = (names: Set<string>) => [...personaOf.entries()].filter(([, n]) => names.has(n)).map(([id]) => id);

    // ---- which executors are in view
    let ids: string[] | null = null;
    if (persona) ids = sessionsOf(new Set([persona]));
    else if (agentId) ids = [agentId];
    else if (scope === 'team') {
        const me = actor.id; const team = new Set<string>([me]);
        const parent = String((await sel('SELECT parent_id FROM agents WHERE id = ?', [me]))[0]?.parent_id ?? '');
        for (const r of await sel('SELECT id FROM agents WHERE parent_id = ANY(?::text[])', [parent ? [me, parent] : [me]])) team.add(String(r.id));
        if (parent) team.add(parent);
        const teamIds = (await sel('SELECT team_id FROM team.member WHERE agent_id = ? UNION SELECT id FROM team.team WHERE supervisor_agent_id = ?', [me, me])).map(r => String(r.team_id));
        if (teamIds.length) {
            for (const r of await sel('SELECT agent_id FROM team.member WHERE team_id = ANY(?::text[]) UNION SELECT supervisor_agent_id FROM team.team WHERE id = ANY(?::text[])', [teamIds, teamIds])) team.add(String(r.agent_id));
            for (const r of await sel('SELECT persona_name FROM team.team_persona WHERE team_id = ANY(?::text[]) AND active', [teamIds])) for (const s of sessionsOf(new Set([String(r.persona_name)]))) team.add(s);
        }
        const names = new Set([...team].map(id => personaOf.get(id)).filter((n): n is string => !!n));
        for (const s of sessionsOf(names)) team.add(s);
        ids = [...team];
    }
    if (ids && !ids.length) return { groupBy, scope, personas: [], agents: [] };

    const rows = await sel('SELECT agent_id, task_id, assignee_agent_id, stars, comment, rated_at FROM team.rating' + (ids ? ' WHERE assignee_agent_id = ANY(?::text[])' : '') + ' ORDER BY rated_at DESC LIMIT 5000', ids ? [ids] : []);
    const avg = (list: Row[]) => Math.round(list.reduce((s, r) => s + Number(r.stars), 0) / list.length * 10) / 10;
    const item = (r: Row) => ({ taskId: String(r.task_id), childAgentId: r.agent_id ? String(r.agent_id) : null, stars: Number(r.stars), comment: String(r.comment ?? ''), at: Number(r.rated_at) });
    const group = (key: (r: Row) => string) => { const by = new Map<string, Row[]>(); for (const r of rows) { const k = key(r); if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); } return [...by.entries()]; };

    if (groupBy === 'session') {
        const agents = group(r => String(r.assignee_agent_id)).map(([id, list]) => ({ agentId: id, persona: personaOf.get(id) ?? null, count: list.length, avg: avg(list), recent: list.slice(0, recent).map(item) })).sort((a, b) => b.count - a.count);
        return { groupBy, scope, personas: [], agents };
    }
    const personas = group(r => { const id = String(r.assignee_agent_id); const n = personaOf.get(id); return n ? 'p:' + n : 'a:' + id; }).map(([k, list]) => ({
        persona: k.startsWith('p:') ? k.slice(2) : null,
        agentIds: [...new Set(list.map(r => String(r.assignee_agent_id)))],
        count: list.length, avg: avg(list),
        recent: list.slice(0, recent).map(r => ({ ...item(r), agentId: String(r.assignee_agent_id) })),
    })).sort((a, b) => b.count - a.count);
    return { groupBy, scope, personas, agents: [] };
}
