/**
 * Average owner rating per executor, from team.rating
 *
 * Read-only. For the passport or hiring: how the owner rated each agent's handed-in tasks (1–5 stars, see team.rate). Without agentId returns every rated executor; with agentId only that one. Missing table = no ratings yet.
 * @param opts.agentId Executor agent id; omit for all.
 * @param opts.recent How many latest ratings to include per executor. @default 5 @minimum 0 @maximum 50
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Executor agent id; omit for all. */
        agentId?: string;
        /** How many latest ratings to include per executor. @default 5 @minimum 0 @maximum 50 */
        recent?: number;
    },
): Promise<{agents:Array<{agentId:string; count:number; avg:number; recent:Array<{taskId:string; childAgentId:string|null; stars:number; comment:string; at:number}>}>}> {
    type Row = Record<string, any>;
    await ctx.fns.team.resolveActor({});
    const id = String(opts.agentId ?? '').trim();
    const recent = Math.max(0, Math.min(50, Number(opts.recent ?? 5) || 0));
    let rows: Row[] = [];
    try { rows = await ctx.fns.procs.db.select({ sql: 'SELECT agent_id, task_id, assignee_agent_id, stars, comment, rated_at FROM team.rating' + (id ? ' WHERE assignee_agent_id = ?' : '') + ' ORDER BY rated_at DESC LIMIT 5000', params: id ? [id] : [] }) as Row[]; }
    catch (e) { if (!/team\.rating|does not exist/.test(String(e))) throw e; }
    const by = new Map<string, Row[]>();
    for (const r of rows) { const k = String(r.assignee_agent_id); if (!by.has(k)) by.set(k, []); by.get(k)!.push(r); }
    const agents = [...by.entries()].map(([agentId, list]) => ({
        agentId, count: list.length, avg: Math.round(list.reduce((s, r) => s + Number(r.stars), 0) / list.length * 10) / 10,
        recent: list.slice(0, recent).map(r => ({ taskId: String(r.task_id), childAgentId: r.agent_id ? String(r.agent_id) : null, stars: Number(r.stars), comment: String(r.comment ?? ''), at: Number(r.rated_at) })),
    })).sort((a, b) => b.count - a.count);
    return { agents };
}
