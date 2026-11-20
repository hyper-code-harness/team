/**
 * List or search a persona's memos: table of contents with relevance, optional full text
 *
 * Without query: every live memo of the persona, newest first (path, title, description, chars, version, updatedAt). With query: memos ranked by how many query words (≥3 letters, case-insensitive, also word stems of 5+ letters) occur in path, title and description (weight 3) and in the text (weight 1); memos with score 0 are dropped. withContent adds the text. Anyone in the team may read, colleagues' memos too (writing stays with the persona and the owner: team.memoSave); name defaults to the caller session's persona. Used by team.brief to pick the memos that go into the prompt in full.
 * @param opts.name Persona name; default: the persona of the calling session.
 * @param opts.query Words to look for, e.g. the task title; empty lists everything.
 * @param opts.limit Maximum memos. @default 60 @minimum 1 @maximum 200
 * @param opts.withContent Include the memo text.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona name; default: the persona of the calling session. */
        name?: string;
        /** Words to look for, e.g. the task title; empty lists everything. */
        query?: string;
        /** Maximum memos. @default 60 @minimum 1 @maximum 200 */
        limit?: number;
        /** Include the memo text. */
        withContent?: boolean;
    },
): Promise<{ name: string; total: number; memos: Array<{ path: string; title: string; description: string; chars: number; version: number; updatedAt: number; score: number; content?: string }> }> {
    type Row = Record<string, any>;
    let name = String(opts.name ?? '').trim();
    if (!name) {
        const actor = await ctx.fns.team.resolveActor({});
        if (actor.kind === 'agent') name = String(((await ctx.fns.procs.db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [actor.id, actor.id] })) as Row[])[0]?.name ?? '');
    }
    if (!name) throw new Error('memoSearch: name required');
    const rows = await ctx.fns.procs.db.select({ sql: 'SELECT path,title,description,content,version,updated_at FROM team.persona_memo WHERE persona_name=? AND deleted_at IS NULL ORDER BY updated_at DESC, path', params: [name] }) as Row[];
    const words = [...new Set(String(opts.query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3))].map(w => (w.length >= 6 ? w.slice(0, w.length - 2) : w));
    const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 60)));
    const scored = rows.map(r => {
        const head = (String(r.path) + ' ' + r.title + ' ' + r.description).toLowerCase(), body = String(r.content).toLowerCase();
        const score = words.reduce((s, w) => s + (head.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0), 0);
        return { r, score };
    });
    const list = (words.length ? scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score || Number(b.r.updated_at) - Number(a.r.updated_at)) : scored).slice(0, limit);
    return {
        name, total: rows.length,
        memos: list.map(({ r, score }) => ({ path: String(r.path), title: String(r.title), description: String(r.description), chars: String(r.content).length, version: Number(r.version), updatedAt: Number(r.updated_at), score, ...(opts.withContent ? { content: String(r.content) } : {}) })),
    };
}
