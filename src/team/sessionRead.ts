/**
 * Read a stretch of a persona's past session: messages fromIdx on, text cut short, tool results as one line
 *
 * For following up a team.sessionSearch hit: returns up to limit messages of the session starting at fromIdx (idx, role, type, time, text ≤ maxChars characters). Tool results are not dumped: one line «[tool result, N chars]: first 120 characters»; assistant tool calls are listed by function name. Any persona's session can be read, colleagues' too (team.persona_session / persona.current_agent_id); the result names its persona. Read-only; a team agent or the signed-in owner. next = the idx to continue from, null at the end.
 * @param opts.agentId Session (agent) id of a persona session.
 * @param opts.fromIdx First message index. @default 0 @minimum 0
 * @param opts.limit Maximum messages. @default 10 @minimum 1 @maximum 40
 * @param opts.maxChars Maximum characters of each message text. @default 600 @minimum 100 @maximum 4000
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Session (agent) id of a persona session. */
        agentId: string;
        /** First message index. @default 0 @minimum 0 */
        fromIdx?: number;
        /** Maximum messages. @default 10 @minimum 1 @maximum 40 */
        limit?: number;
        /** Maximum characters of each message text. @default 600 @minimum 100 @maximum 4000 */
        maxChars?: number;
    },
): Promise<{ agentId: string; persona: string; title: string; count: number; next: number | null; messages: Array<{ idx: number; role: string; type: string; at: number; text: string; tools?: string[] }> }> {
    type Row = Record<string, any>;
    await ctx.fns.team.resolveActor({});
    const agentId = String(opts.agentId ?? '').trim();
    if (!agentId) throw new Error('sessionRead: agentId required');
    const p = (await ctx.fns.procs.db.select({ sql: 'SELECT persona_name AS name FROM team.persona_session WHERE agent_id=? UNION ALL SELECT name FROM team.persona WHERE current_agent_id=? LIMIT 1', params: [agentId, agentId] }) as Row[])[0];
    if (!p) throw new Error(`sessionRead: ${agentId} is not a persona session`);
    const from = Math.max(0, Math.floor(Number(opts.fromIdx ?? 0) || 0));
    const limit = Math.max(1, Math.min(40, Number(opts.limit ?? 10) || 10));
    const max = Math.max(100, Math.min(4000, Number(opts.maxChars ?? 600) || 600));
    const [a] = await ctx.fns.procs.db.select({ sql: 'SELECT title FROM agents WHERE id=?', params: [agentId] }) as Row[];
    const [c] = await ctx.fns.procs.db.select({ sql: 'SELECT count(*)::int n FROM messages WHERE agent_id=?', params: [agentId] }) as Row[];
    const rows = await ctx.fns.procs.db.select({ sql: 'SELECT idx, role, message_type, ts, left(content, ?) AS content, length(content) AS len, tool_calls FROM messages WHERE agent_id=? AND idx>=? ORDER BY idx LIMIT ?', params: [Math.max(max, 120) + 1, agentId, from, limit + 1] }) as Row[];
    const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const messages = rows.slice(0, limit).map(r => {
        const text = String(r.content ?? '');
        const tc = Array.isArray(r.tool_calls) ? r.tool_calls : [];
        const tools = tc.map((t: any) => String(t?.name ?? t?.function?.name ?? '?'));
        return {
            idx: Number(r.idx), role: String(r.role), type: String(r.message_type ?? 'message'), at: Number(r.ts ?? 0),
            text: r.role === 'tool' ? `[tool result, ${Number(r.len)} chars]: ${cut(text.replace(/\s+/g, ' '), 120)}` : cut(text, max),
            ...(tools.length ? { tools } : {}),
        };
    });
    return { agentId, persona: String(p.name), title: String(a?.title ?? ''), count: Number(c?.n ?? 0), next: rows.length > limit ? Number(rows[limit]!.idx) : null, messages };
}
