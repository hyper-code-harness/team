/**
 * Read one memo of a persona with its recent revisions
 *
 * Returns the memo (title, description, text, version) or null when it does not exist; a deleted memo comes back with deleted:true and empty text, its revisions still listed (restore one with team.memoSave revertOf). Anyone in the team may read, colleagues' memos too (writing stays with the persona and the owner); name defaults to the caller session's persona.
 * @param opts.name Persona name; default: the persona of the calling session.
 * @param opts.path Memo path, e.g. "code/board.md".
 * @param opts.revisions How many latest revisions to include. @default 10 @minimum 0 @maximum 100
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona name; default: the persona of the calling session. */
        name?: string;
        /** Memo path, e.g. "code/board.md". */
        path: string;
        /** How many latest revisions to include. @default 10 @minimum 0 @maximum 100 */
        revisions?: number;
    },
): Promise<{ name: string; path: string; title: string; description: string; content: string; version: number; updatedAt: number; deleted: boolean; revisions: Array<{ id: string; authorKind: string; authorId: string; summary: string; reason: string; before: string; after: string; deleted: boolean; revertOf: string | null; at: number }> } | null> {
    type Row = Record<string, any>;
    let name = String(opts.name ?? '').trim();
    if (!name) {
        const actor = await ctx.fns.team.resolveActor({});
        if (actor.kind === 'agent') name = String(((await ctx.fns.procs.db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [actor.id, actor.id] })) as Row[])[0]?.name ?? '');
    }
    const path = String(opts.path ?? '').trim();
    if (!name || !path) throw new Error('memoRead: name and path required');
    const m = (await ctx.fns.procs.db.select({ sql: 'SELECT * FROM team.persona_memo WHERE persona_name=? AND path=?', params: [name, path] }) as Row[])[0];
    if (!m) return null;
    const n = Math.max(0, Math.min(100, Number(opts.revisions ?? 10)));
    const revs = n ? await ctx.fns.procs.db.select({ sql: "SELECT * FROM team.persona_rev WHERE persona_name=? AND field='memo' AND path=? ORDER BY at DESC, id DESC LIMIT ?", params: [name, path, n] }) as Row[] : [];
    const json = (v: unknown): Row => { if (!v) return {}; if (typeof v === 'object') return v as Row; try { return JSON.parse(String(v)); } catch { return {}; } };
    const deleted = m.deleted_at != null;
    return {
        name, path, title: String(m.title), description: String(m.description), content: deleted ? '' : String(m.content), version: Number(m.version), updatedAt: Number(m.updated_at), deleted,
        revisions: revs.map(r => ({ id: String(r.id), authorKind: String(r.author_kind), authorId: String(r.author_id), summary: String(r.summary), reason: String(r.reason ?? ''), before: String(r.before), after: String(r.after), deleted: !!json(r.meta).deleted, revertOf: r.revert_of ?? null, at: Number(r.at) })),
    };
}
