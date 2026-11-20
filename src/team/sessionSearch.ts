/**
 * Search the messages of a persona's past sessions: who said what, where
 *
 * Full-text over the message text of the persona's sessions (team.persona_session + persona.current_agent_id): user, assistant and agent messages; tool results, status lines and triggers are skipped, tool-call arguments are not searched. Matching is by query words (≥3 letters, case-insensitive; words of 5+ letters also match by stem — the last letter cut, two from 7+ — so «шапку» finds «шапка»), ranked by how many words occur, then newest first. Rows are compact: agentId, idx, role, message type, time and a fragment of ≤300 characters around the first match; read the surroundings with team.sessionRead({ agentId, fromIdx: idx - 3 }). persona defaults to the caller session's persona ('*' = all personas); agentId narrows to one session (it must be a persona session). The caller's own session is included. Any persona's sessions can be searched by a team agent (colleagues too: persona 'Даша' or '*'); every row names its persona. Read-only; a team agent or the signed-in owner.
 * @param opts.query Words to look for; required.
 * @param opts.persona Persona name; default: the persona of the calling session; '*' = all personas.
 * @param opts.agentId Only this session (a persona session id).
 * @param opts.limit Maximum rows. @default 10 @minimum 1 @maximum 50
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Words to look for; required. */
        query: string;
        /** Persona name; default: the persona of the calling session; '*' = all personas. */
        persona?: string;
        /** Only this session (a persona session id). */
        agentId?: string;
        /** Maximum rows. @default 10 @minimum 1 @maximum 50 */
        limit?: number;
    },
): Promise<{ persona: string; sessions: number; total: number; rows: Array<{ agentId: string; persona: string; title: string; idx: number; role: string; type: string; at: number; fragment: string; score: number }> }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    let persona = String(opts.persona ?? '').trim();
    const agentId = String(opts.agentId ?? '').trim();
    if (!persona && !agentId && actor.kind === 'agent') persona = String(((await ctx.fns.procs.db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [actor.id, actor.id] })) as Row[])[0]?.name ?? '');
    if (!persona) persona = '*';
    const words = [...new Set(String(opts.query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3))].map(w => (w.length >= 7 ? w.slice(0, -2) : w.length >= 5 ? w.slice(0, -1) : w)).slice(0, 8);
    if (!words.length) throw new Error('sessionSearch: query needs at least one word of 3+ letters');
    const limit = Math.max(1, Math.min(50, Number(opts.limit ?? 10) || 10));
    const sess = await ctx.fns.procs.db.select({ sql: 'SELECT agent_id, persona_name FROM team.persona_session' + (persona === '*' ? '' : ' WHERE persona_name=?') + ' UNION SELECT current_agent_id, name FROM team.persona WHERE current_agent_id IS NOT NULL' + (persona === '*' ? '' : ' AND name=?'), params: persona === '*' ? [] : [persona, persona] }) as Row[];
    const who = new Map<string, string>(sess.map(r => [String(r.agent_id), String(r.persona_name)]));
    if (agentId && !who.has(agentId)) throw new Error(`sessionSearch: ${agentId} is not a session of ${persona === '*' ? 'any persona' : persona}`);
    const ids = agentId ? [agentId] : [...who.keys()];
    if (!ids.length) return { persona, sessions: 0, total: 0, rows: [] };
    const pats = words.map(w => '%' + w.replace(/[\\%_]/g, m => '\\' + m) + '%');
    const rows = await ctx.fns.procs.db.select({
        sql: `SELECT m.agent_id, m.idx, m.role, m.message_type, m.ts, m.content, a.title,
                 (SELECT count(*) FROM unnest(?::text[]) p WHERE m.content ILIKE p)::int AS score
              FROM messages m JOIN agents a ON a.id = m.agent_id
              WHERE m.agent_id = ANY(?::text[]) AND m.role <> 'tool' AND coalesce(m.message_type,'message') NOT IN ('status_line','trigger','job','notification')
                AND m.content NOT LIKE 'You are a delegated subagent%' AND m.content ILIKE ANY(?::text[])
              ORDER BY score DESC, m.ts DESC LIMIT 500`,
        params: [pats, ids, pats],
    }) as Row[];
    const frag = (s: string) => {
        const flat = s.replace(/\s+/g, ' ').trim(), low = flat.toLowerCase();
        const i = Math.max(0, Math.min(...words.map(w => { const k = low.indexOf(w); return k < 0 ? Infinity : k; })));
        const from = Number.isFinite(i) ? Math.max(0, i - 100) : 0, out = flat.slice(from, from + 300);
        return (from > 0 ? '…' : '') + (out.length < flat.length - from ? out.slice(0, 299) + '…' : out);
    };
    return {
        persona, sessions: ids.length, total: rows.length,
        rows: rows.slice(0, limit).map(r => ({ agentId: String(r.agent_id), persona: who.get(String(r.agent_id)) ?? '', title: String(r.title ?? '').slice(0, 100), idx: Number(r.idx), role: String(r.role), type: String(r.message_type ?? 'message'), at: Number(r.ts ?? 0), fragment: frag(String(r.content ?? '')), score: Number(r.score) })),
    };
}
